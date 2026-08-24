/**
 * HostRuntime — the deep module that owns the headless conversation lifecycle.
 *
 * `runConversation` previously did five things inline in one function:
 * record ensure (with a duplicated fallback), `openConversation`, presence
 * acquire, `openHeadlessSession`, and a hand-rolled `Promise` with a dead
 * `setInterval`, a monkey-patched `source.close`, and a double
 * `presence.release()` (idempotent only by accident). The interface was
 * `(opts) => Promise<{conversationId, dir}>` — it leaked nothing testable
 * about abort ordering or presence lifetime. Bugs hid in the wiring:
 * abort must detach once, release presence once, and close the session,
 * but there was no seam where that invariant was enforceable.
 *
 * Now one module owns the whole discipline — record ensure → host open →
 * presence acquire → source attach → abort/close → presence release — and
 * hides it behind a small, deep interface: `startHeadless(opts)` returns
 * a `RunningConversation` with `{abort, done, presenceHeld}`. The caller
 * (the CLI's `run` adapter, and the future daemon) sees one method, not
 * `acquire -> catch-up -> reduce -> write`. The deletion test passes:
 * deleting this module would scatter presence handling across `run`,
 * `announce` (which briefly acquires), and every test that needs abort
 * semantics.
 *
 * B (controller cohesion): the runtime now consumes the controller as its
 * takeover policy. Before, `controller.ts:decideAction` encoded D-021
 * (interactive-unattached → await-reattach, agent-gone → headless-takeover)
 * but had zero callers — runtime always seized the conversation. Now the
 * runtime folds state → derives ChannelStatus via the single liveness
 * module → consults the controller before acquiring the presence lock.
 * An interactive-unattached channel returns an AwaitToken without ever
 * acquiring presence or spawning a harness, so a living human session is
 * waited on, never taken over. The deletion test passes: deleting the
 * controller would scatter lease/presence arithmetic into runtime and
 * watch again.
 *
 * What it is NOT: it is not the durable log (ConversationLog), not the
 * flock primitive, and not the harness runner — it hosts them.
 */

import { createHcnRunner } from "../harness/hcn-runner.js";
import { nodeHarnessDeps } from "../harness/node-deps.js";
import type { HarnessName, HarnessRunner } from "../harness/runner.js";
import { decideAction } from "../modes/controller.js";
import { createHeadlessHost } from "../modes/host.js";
import type { ChannelStatus, Frame } from "../protocol/index.js";
import { channelStatus } from "../protocol/liveness.js";
import { acquirePresence, type PresenceEvent, type PresenceHandle } from "../store/presence.js";
import { type HostRecord, openConversation } from "../store/store.js";
import { type Conversations, conversations } from "./conversations.js";
import { harnessForName, supportsSession } from "./harness.js";

/** Production deps for the runtime. All fields are injectable for tests. */
export interface RuntimeDeps {
  readonly rootDir?: string;
  readonly conversationId?: string;
  /** Harness to drive headlessly. Defaults to `claudeCode` (or `LUCID_HARNESS` env). */
  readonly harness?: HarnessName;
  /** Bare name override (`claude`|`codex`|`pi`|`muse`) — resolved via `harnessForName`. Takes precedence only when `harness` is not supplied. */
  readonly harnessName?: string;
  readonly runner?: HarnessRunner;
  readonly onRecord?: (r: HostRecord) => void;
  readonly onPresenceEvent?: (e: PresenceEvent) => void;
  readonly signal?: AbortSignal;
  /** Interactive presence probe for D-021 (the ps-level fact). Defaults to unknown. Injected so tests assert takeover vs await deterministically. */
  readonly presence?: () => boolean | undefined;
  // seams — injected in tests, defaulted in production
  readonly conversationsFactory?: (rootDir?: string) => Conversations;
  readonly acquirePresenceFn?: typeof acquirePresence;
  readonly openConversationFn?: typeof openConversation;
  readonly createHeadlessHostFn?: typeof createHeadlessHost;
  /** @deprecated — prefer createHeadlessHostFn (single strategy table) */
  readonly openHeadlessSessionFn?: (
    deps: Parameters<typeof createHeadlessHost>[0] & { sessionId: string },
  ) => ReturnType<typeof createHeadlessHost>;
  /** @deprecated — prefer createHeadlessHostFn */
  readonly openHeadlessTurnsFn?: (
    deps: Parameters<typeof createHeadlessHost>[0],
  ) => ReturnType<typeof createHeadlessHost>;
  readonly channelStatusFn?: typeof channelStatus;
  readonly decideActionFn?: typeof decideAction;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly randomConversationSuffix?: () => string;
}

export interface RunningConversation {
  readonly kind: "running";
  readonly conversationId: string;
  readonly dir: string;
  /** Resolves when the source closes or the signal aborts. */
  readonly done: Promise<void>;
  /** Abort the conversation: detaches the source and releases presence once. */
  abort(): void;
  /** Whether the presence lock is still held. */
  readonly presenceHeld: () => boolean;
}

export interface AwaitToken {
  readonly kind: "await-reattach";
  readonly conversationId: string;
  readonly dir: string;
  readonly status: ChannelStatus;
  /** Human-readable resume instruction for the operator. */
  readonly resumeInstruction: string;
}

export type StartResult = RunningConversation | AwaitToken;

export const isAwaitToken = (r: StartResult): r is AwaitToken => r.kind === "await-reattach";

/**
 * Start a headless conversation. Acquires the presence lock for the
 * conversation's lifetime (kernel-released on death), opens the durable
 * host, attaches a headless source, and wires effects to the source.
 *
 * Presence is released exactly once — whether the source closes, the
 * signal aborts, or `abort()` is called. No monkey-patching, no dead
 * interval, no double-release.
 *
 * D-021 gate: before acquiring presence, derives ChannelStatus via the
 * single liveness module and consults the controller. An
 * interactive-unattached channel (live human process, dead lease) returns
 * an AwaitToken without acquiring presence or spawning a harness.
 */
export const startHeadless = async (opts: RuntimeDeps = {}): Promise<StartResult> => {
  const convsFactory = opts.conversationsFactory ?? conversations;
  const acquirePresenceFn = opts.acquirePresenceFn ?? acquirePresence;
  const openConversationFn = opts.openConversationFn ?? openConversation;
  const createHeadlessHostFn = opts.createHeadlessHostFn ?? createHeadlessHost;
  // Backward compat: old tests inject openHeadlessSessionFn/TurnsFn — map them onto the single host
  const openHeadlessSessionFn =
    opts.openHeadlessSessionFn ??
    ((deps: Parameters<typeof createHeadlessHostFn>[0]) =>
      createHeadlessHostFn(deps, "headless-session"));
  const openHeadlessTurnsFn =
    opts.openHeadlessTurnsFn ??
    ((deps: Parameters<typeof createHeadlessHostFn>[0]) =>
      createHeadlessHostFn(deps, "headless-turn"));
  const channelStatusFn = opts.channelStatusFn ?? channelStatus;
  const decideActionFn = opts.decideActionFn ?? decideAction;
  const nowFn = opts.now ?? (() => Date.now());
  const uuidFn = opts.randomUUID ?? (() => crypto.randomUUID());
  const suffixFn = opts.randomConversationSuffix ?? (() => Math.random().toString(36).slice(2, 6));
  const harness = opts.harness ?? harnessForName(opts.harnessName);
  const presenceProbe = opts.presence ?? (() => undefined);

  const convs = convsFactory(opts.rootDir);
  const conversationId = opts.conversationId ?? `conv-${Date.now()}-${suffixFn()}`;
  const dir = convs.dirFor(conversationId);

  // Ensure the record exists (conversations.ensure handles create-vs-open
  // and the fallback read — no duplication here).
  const { secret } = convs.ensure(conversationId);

  let receive: ((frame: Frame) => void) | undefined;
  // RFC-04 R2: the host's dispatch gate must read the presence handle
  // this runtime actually holds — not `presence` above, the ps-level
  // interactive-process probe, which is a different fact. The handle does
  // not exist yet when the host is opened (the D-021 gate below may
  // return without ever acquiring), so the seam reads it through this
  // closure: until acquisition it answers false, which is the truth —
  // this process holds nothing.
  let presenceHandle: PresenceHandle | undefined;
  const host = openConversationFn(dir, {
    now: nowFn,
    presence: () => presenceProbe(),
    executorLease: () => presenceHandle?.held() === true,
    onEffect: (eff) => {
      if (eff.type === "send") receive?.(eff.frame);
    },
    onRecord: (r) => opts.onRecord?.(r),
  });

  // D-021 gate — derive status via the single liveness module and
  // consult the controller before acquiring presence. This is the
  // second adapter of the liveness seam (watch is the first), so the
  // seam becomes real: one adapter = hypothetical, two = real.
  const presenceVal = presenceProbe();
  const status = channelStatusFn(host.state(), nowFn(), {
    processAlive: presenceVal === true,
  });
  const action = decideActionFn(status);
  if (action.action === "await-reattach") {
    const resumeInstruction = `interactive session still attached for ${conversationId} — awaiting reattach (run will retry after the human yields or the lease expires)`;
    try {
      host.close();
    } catch {}
    return {
      kind: "await-reattach",
      conversationId,
      dir,
      status,
      resumeInstruction,
    };
  }

  // Presence is held for the source's lifetime and kernel-released on
  // death; the runtime ensures a single explicit release.
  const presence = acquirePresenceFn(dir, conversationId, {
    onEvent: opts.onPresenceEvent,
  });
  // Publish the handle to the host's R2 gate: from here on, transacts in
  // this process see themselves as the holder, and after `release()` (or
  // a takeover) they stop dispatching.
  presenceHandle = presence;
  let released = false;
  const doRelease = (): void => {
    if (released) return;
    released = true;
    try {
      presence.release();
    } catch {}
  };

  let turnCount = 0;
  const sessionId = uuidFn();

  // Single headless entry — the Host's strategy table owns the mode
  // split (session vs turn). The runtime only selects the profile via
  // supportsSession, then delegates the whole lifecycle to the Host.
  // Runtime-verified, not guessed: hcn reads the descriptor and answers
  // whether this harness holds a persistent session (PLAN D-008). One
  // inspect per run, before the profile is chosen.
  const runner = opts.runner ?? createHcnRunner(nodeHarnessDeps());
  const profile = (await supportsSession(runner, harness)) ? "headless-session" : "headless-turn";
  const baseDeps = {
    harness,
    conversationId,
    secret,
    runner,
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
  } as const;
  const source =
    profile === "headless-session"
      ? openHeadlessSessionFn({ ...baseDeps, sessionId })
      : openHeadlessTurnsFn(baseDeps);
  receive = source.receive;

  // Wire termination: done resolves when the source is closed or the
  // signal aborts. No polling, no monkey-patch.
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let doneResolved = false;
  const finish = (): void => {
    if (doneResolved) return;
    doneResolved = true;
    doRelease();
    resolveDone();
  };

  // Abort helper — idempotent, releases presence exactly once.
  const abort = (): void => {
    if (doneResolved) return;
    try {
      source.close();
    } catch {}
    finish();
  };

  // Signal abort
  if (opts.signal) {
    if (opts.signal.aborted) {
      // Defer to next tick so the caller can observe the handle.
      queueMicrotask(abort);
    } else {
      opts.signal.addEventListener("abort", abort, { once: true });
    }
  }

  // Wrap source.close so an external close also finishes the runtime.
  // Avoid mutating the source object when possible — keep our own flag
  // and finish on any close call. We patch only to observe.
  const originalClose = source.close.bind(source);
  (source as { close: () => void }).close = () => {
    try {
      originalClose();
    } finally {
      finish();
    }
  };

  // Ensure finish also handles process-level cleanup when the source's
  // internal pump detaches (the pump calls detachOnce but not close;
  // the explicit close path above covers operator abort. For harness
  // exit without an explicit close, the caller should call abort/done.
  // We also finish when the host's presence is externally released.)
  // No dead setInterval — the host's heartbeat/lease is the liveness
  // signal, not a poll.

  return {
    kind: "running",
    conversationId,
    dir,
    done,
    abort,
    presenceHeld: () => presence.held() && !released,
  };
};

/**
 * Convenience: run until done. Preserves the original `runConversation`
 * promise shape for the CLI adapter. When the controller gates the
 * conversation as await-reattach, returns immediately without starting
 * a harness — the caller (dispatch) surfaces the resume instruction.
 */
export const runHeadless = async (
  opts: RuntimeDeps = {},
): Promise<{ conversationId: string; dir: string; awaitToken?: AwaitToken }> => {
  const handle = await startHeadless(opts);
  if (isAwaitToken(handle)) {
    return { conversationId: handle.conversationId, dir: handle.dir, awaitToken: handle };
  }
  await handle.done;
  return { conversationId: handle.conversationId, dir: handle.dir };
};
