import { LockError } from "../store/flock.js";
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
import { openHonoringDriver } from "../modes/honor.js";
import { createHeadlessHost, hostSeamFor } from "../modes/host.js";
import type { ChannelStatus, Frame } from "../protocol/index.js";
import { inputFrame } from "../protocol/index.js";
import { channelStatus } from "../protocol/liveness.js";
import { createTurnIds } from "../protocol/turn-id.js";
import { readDriverPreference } from "../store/driver-preference.js";
import { acquirePresence, type PresenceEvent, type PresenceHandle } from "../store/presence.js";
import { type HostRecord, openConversation } from "../store/store.js";
import { followRecord } from "../store/tailer.js";
import { resolveStartupHarness, supportsSession } from "./harness.js";
import { type Conversations, conversations } from "./record-addressing.js";

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
  readonly diagnostic?: (line: string) => void;
  /** Called once the conversation is running and before the caller blocks on
   * `done`. `run` holds the terminal for the life of the session, so without
   * this it printed nothing at all - which is indistinguishable from a hang,
   * and is exactly how it read to the first person who used it. */
  readonly onStart?: (running: RunningConversation) => void;
  readonly onPresenceEvent?: (e: PresenceEvent) => void;
  readonly signal?: AbortSignal;
  /** Interactive presence probe for D-021 (the ps-level fact). Defaults to unknown. Injected so tests assert takeover vs await deterministically. */
  readonly presence?: () => boolean | undefined;
  // seams — injected in tests, defaulted in production
  readonly conversationsFactory?: (rootDir?: string) => Conversations;
  readonly acquirePresenceFn?: typeof acquirePresence;
  readonly openConversationFn?: typeof openConversation;
  readonly createHeadlessHostFn?: typeof createHeadlessHost;
  readonly channelStatusFn?: typeof channelStatus;
  readonly decideActionFn?: typeof decideAction;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly randomConversationSuffix?: () => string;
  readonly pollMs?: number;
}

export class PresenceAcquireError extends Error {
  constructor(
    readonly conversationId: string,
    cause: unknown,
  ) {
    super(`could not acquire presence for ${conversationId}`, { cause });
    this.name = "PresenceAcquireError";
  }
}

export interface RunningConversation {
  readonly kind: "running";
  readonly conversationId: string;
  readonly dir: string;
  /** Which harness, and which profile hcn said it supports. Reported so the
   * CLI can say what it is driving without asking a second time. */
  readonly harness: HarnessName;
  readonly profile: "headless-session" | "headless-turn";
  /** Resolves when the source closes or the signal aborts. */
  readonly done: Promise<void>;
  /** Abort the conversation: detaches the source and releases presence once. */
  abort(): void;
  /** Whether the presence lock is still held. */
  readonly presenceHeld: () => boolean;
}

export interface DrivenConversation extends RunningConversation {
  readonly host: import("../store/conversation-host.js").ConversationHost;
  readonly source: import("../modes/honor.js").HonoringSource;
  observeTrigger(observer: () => void): () => void;
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
export const openDrivenConversation = async (
  opts: RuntimeDeps = {},
): Promise<DrivenConversation | AwaitToken> => {
  const convsFactory = opts.conversationsFactory ?? conversations;
  const acquirePresenceFn = opts.acquirePresenceFn ?? acquirePresence;
  const openConversationFn = opts.openConversationFn ?? openConversation;
  const createHeadlessHostFn = opts.createHeadlessHostFn ?? createHeadlessHost;
  const channelStatusFn = opts.channelStatusFn ?? channelStatus;
  const decideActionFn = opts.decideActionFn ?? decideAction;
  const nowFn = opts.now ?? (() => Date.now());
  const uuidFn = opts.randomUUID ?? (() => crypto.randomUUID());
  const suffixFn = opts.randomConversationSuffix ?? (() => Math.random().toString(36).slice(2, 6));
  // Startup harness resolution happens below, with the record's driver
  // preference in hand (RFC-12): the flag/env pin, else the preference's
  // harness, else the default.
  const presenceProbe = opts.presence ?? (() => undefined);

  const convs = convsFactory(opts.rootDir);
  const conversationId = opts.conversationId ?? `conv-${Date.now()}-${suffixFn()}`;
  const dir = convs.dirFor(conversationId);

  // Ensure the record exists (conversations.ensure handles create-vs-open
  // and the fallback read — no duplication here).
  const { secret } = convs.ensure(conversationId);

  let receive: ((frame: Frame) => void) | undefined;
  // The append callback and follower see the same input. Deliver it once
  // per source; a replacement owns replay from the durable cursor.
  const handed = new Set<string>();
  const deliver = (frame: Frame): void => {
    if (receive === undefined || (frame.kind === "input" && handed.has(frame.id))) return;
    receive(frame);
    if (frame.kind === "input") handed.add(frame.id);
  };
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
      if (eff.type === "send") deliver(eff.frame);
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
  let presence: PresenceHandle;
  try {
    presence = acquirePresenceFn(dir, conversationId, { onEvent: opts.onPresenceEvent });
  } catch (cause) {
    host.close();
    if (cause instanceof LockError && cause.code === "lock-unavailable") throw cause;
    throw new PresenceAcquireError(conversationId, cause);
  }
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

  // Unique across restarts: a reused id is refused by the reducer, and the
  // driver would record nothing the agent says. See src/protocol/turn-id.ts.
  const mintTurnId = createTurnIds();

  // RFC-12 startup honor: read the preference and spawn under it. An
  // explicit harness at spawn pins the harness for this process's life;
  // the preference's harness beats the default; model, provider and effort
  // have no spawn-flag surface, so the preference is their only source
  // besides hcn's defaults.
  const startup = resolveStartupHarness({ harness: opts.harness, harnessName: opts.harnessName });
  const preference = readDriverPreference(dir);
  const harness = startup.pinned ? startup.harness : (preference?.harness ?? startup.harness);
  // Runtime-verified, not guessed: hcn reads the descriptor and answers
  // whether a harness holds a persistent session (PLAN D-008), once per
  // spawn through the honoring driver below.
  const runner = opts.runner ?? createHcnRunner(nodeHarnessDeps());
  // Wire termination: done resolves when the source is closed or the
  // signal aborts. No polling, no monkey-patch.
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let doneResolved = false;
  // Bind the tailer's lifetime to the runtime's abort, so abort() and
  // done stop it.
  const tailerAbort = new AbortController();
  const finish = (): void => {
    if (doneResolved) return;
    doneResolved = true;
    receive = undefined;
    try {
      tailerAbort.abort();
    } catch {}
    try {
      host.close();
    } catch {}
    doRelease();
    resolveDone();
  };

  const baseDeps = {
    conversationId,
    secret,
    runner,
    mintTurnId,
    now: nowFn,
    onEnded: (end: import("../modes/host.js").SourceEnd) => {
      if (doneResolved) return;
      try {
        if (end.kind === "store-failed")
          (
            opts.diagnostic ??
            ((line: string) => {
              process.stderr.write(line);
            })
          )(
            `${JSON.stringify({
              code: end.code,
              conversationId,
              operation: end.operation,
              ...(end.artifactId === undefined ? {} : { artifactId: end.artifactId }),
            })}\n`,
          );
      } catch {
      } finally {
        finish();
      }
    },
    sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
    host: hostSeamFor(host),
  } as const;

  // A second driver must not strand a presence lock it cannot attach
  // behind: if acquiring succeeded but attaching then fails, release
  // presence and close the host before propagating the failure.
  //
  // RFC-12: the source is opened through the honoring driver, which owns
  // the per-spawn flags (the preference folded in above for the first
  // spawn, the boundary rule for every one after) and re-opens through
  // this same factory when the preference changes.
  //
  // The dispatch watermark below: each source's attach advanced the
  // durable cursor past its own attach batch (the replay inside it
  // reached the source directly), so the tailer starts looking after it -
  // re-collecting that batch would hand the replayed inputs to the source
  // a second time.
  let lookedAt = 0;
  let source: import("../modes/honor.js").HonoringSource;
  let profile: "headless-session" | "headless-turn";
  try {
    source = await openHonoringDriver({
      base: baseDeps,
      sessionCapable: (h) => supportsSession(runner, h),
      initialHarness: harness,
      harnessPinned: startup.pinned,
      readPreference: () => readDriverPreference(dir),
      mintSessionId: uuidFn,
      createHostFn: createHeadlessHostFn,
      onSpawn: () => {
        handed.clear();
        lookedAt = host.cursor();
      },
    });
    profile = source.state().profile;
  } catch (e) {
    try {
      host.close();
    } catch {}
    doRelease();
    throw e;
  }
  if (!doneResolved) receive = source.receive;

  // Abort helper — idempotent, releases presence exactly once.
  const abort = (): void => {
    if (doneResolved) return;
    try {
      tailerAbort.abort();
    } catch {}
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

  // The durable cursor records what was DISPATCHED, not what was looked
  // at. A cursor entry is itself new bytes, so writing one past a
  // no-effect range puts goodBytes past the cursor again and the next
  // tick writes another — an idle conversation then grows its log
  // forever. Track how far we have looked in a process-local variable
  // and persist only after real dispatch. `lookedAt` was declared before
  // the source opened: each attach (the first and every swap) sets it
  // past that attach's own effects through onSpawn.

  /** Deliver inputs the reducer armed for redelivery but that no boundary
   * is coming for.
   *
   * `enqueueInput` sets `redeliver: !live` — an input written while this
   * driver's lease had lapsed is queued, not delivered, and armed instead.
   * The arming drains at a turn boundary or at the next attach. A driver
   * sitting idle reaches neither: it has no turn to end, and it does not
   * re-attach while it lives.
   *
   * The lease lapses after LEASE_TTL_MS with nothing written, and waiting
   * for a person to type is exactly that. So the common case — open a
   * conversation, think for a minute, send — armed the input and then had
   * nowhere to drain it, and the send was never answered. The record kept
   * it `outstanding` forever.
   *
   * The rule this restores is already the contract's
   * (`docs/skill-chat-substrate.md`): with no turn running an input is
   * delivered straight away, because holding it for a boundary that will
   * never come is a hang, not a policy. */
  const drainArmed = (): void => {
    if (receive === undefined) return;
    let inputs: readonly import("../protocol/index.js").QueuedInput[];
    try {
      inputs = host.state().inputs;
    } catch {
      return;
    }
    for (const queued of inputs) {
      if (queued.status !== "outstanding" || queued.redeliver !== true) continue;
      if (handed.has(queued.id)) continue;
      if (presenceHandle?.held() !== true) return;
      try {
        deliver(inputFrame(queued));
      } catch {}
    }
  };

  const observers = new Set<() => void>();
  const onTrigger = (tailer: import("../store/tailer.js").RecordTailer): void => {
    if (doneResolved) return;
    // peek() is lock-free and may see a torn tail — only for DECIDING
    // whether to bother. Anything we act on goes through the locked
    // collect.
    let snap: { goodBytes: number };
    try {
      snap = tailer.peek();
    } catch {
      return;
    }
    if (snap.goodBytes <= lookedAt) return;
    let batch: ReturnType<typeof host.collectEffects>;
    try {
      batch = host.collectEffects(lookedAt);
    } catch {
      return;
    }
    // No effects in this range — we have looked but not dispatched, so
    // advance the process-local cursor only and do not persist. An input
    // that produced no effect because the lease had lapsed is in this
    // range, and advancing past it is why it was lost: nothing re-reads a
    // range once looked at. Drain the arming before advancing.
    if (batch.entries.length === 0) {
      drainArmed();
      lookedAt = batch.goodBytes;
      return;
    }
    // Never dispatch while holding the append lock. Collect above held
    // it, this loop does not. Check the lease between effects and stop
    // before the next one if it is lost. Do not advance the cursor
    // after a loss — an effect already handed to a harness cannot be
    // recalled, and the successor will redeliver the batch.
    for (const entry of batch.entries) {
      for (const eff of entry.effects) {
        if (presenceHandle?.held() !== true) return;
        if (eff.type === "send") {
          try {
            deliver(eff.frame);
          } catch {}
        }
      }
    }
    if (presenceHandle?.held() !== true) return;
    // Advance AFTER dispatch, never before. A crash in the gap repeats
    // the batch; advancing first would lose it.
    try {
      host.advanceCursor(batch.goodBytes);
    } catch {}
    // An armed input can sit in the same range as a delivered one, so the
    // drain runs on both paths, not just the empty one.
    drainArmed();
    lookedAt = batch.goodBytes;
  };

  // Fire and forget, but never unobserved: a rejection here would
  // otherwise be an unhandled one, and the symptom - a conversation that
  // records an input and never answers it - gives no hint where to look.
  void followRecord({
    dir,
    pollMs: opts.pollMs ?? 500,
    signal: tailerAbort.signal,
    tailerDeps: { now: nowFn, presence: () => presenceProbe() },
    onTrigger: (tailer) => {
      try {
        onTrigger(tailer);
      } finally {
        for (const observer of observers) observer();
      }
    },
  }).catch(() => {});

  return {
    kind: "running",
    host,
    source,
    observeTrigger: (observer) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    conversationId,
    dir,
    harness,
    profile,
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
  opts.onStart?.(handle);
  await handle.done;
  return { conversationId: handle.conversationId, dir: handle.dir };
};

export const startHeadless = (opts: RuntimeDeps = {}): Promise<StartResult> =>
  openDrivenConversation(opts);
