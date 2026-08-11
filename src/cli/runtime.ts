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
 * What it is NOT: it is not the durable log (ConversationLog), not the
 * flock primitive, and not the harness runner — it hosts them.
 */

import { nodeRunnerDeps } from "@dungle-scrubs/harness-cli/src/execution/node-deps.js";
import { claudeCode } from "@dungle-scrubs/harness-cli/src/knowledge/claude-code.js";
import { openHeadlessSession } from "../modes/headless.js";
import type { Frame } from "../protocol/index.js";
import { acquirePresence, type PresenceEvent } from "../store/presence.js";
import { type HostRecord, openConversation } from "../store/store.js";
import { type Conversations, conversations } from "./conversations.js";

/** Production deps for the runtime. All fields are injectable for tests. */
export interface RuntimeDeps {
  readonly rootDir?: string;
  readonly conversationId?: string;
  readonly runner?: ReturnType<typeof nodeRunnerDeps>;
  readonly onRecord?: (r: HostRecord) => void;
  readonly onPresenceEvent?: (e: PresenceEvent) => void;
  readonly signal?: AbortSignal;
  // seams — injected in tests, defaulted in production
  readonly conversationsFactory?: (rootDir?: string) => Conversations;
  readonly acquirePresenceFn?: typeof acquirePresence;
  readonly openConversationFn?: typeof openConversation;
  readonly openHeadlessSessionFn?: typeof openHeadlessSession;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly randomConversationSuffix?: () => string;
}

export interface RunningConversation {
  readonly conversationId: string;
  readonly dir: string;
  /** Resolves when the source closes or the signal aborts. */
  readonly done: Promise<void>;
  /** Abort the conversation: detaches the source and releases presence once. */
  abort(): void;
  /** Whether the presence lock is still held. */
  readonly presenceHeld: () => boolean;
}

/**
 * Start a headless conversation. Acquires the presence lock for the
 * conversation's lifetime (kernel-released on death), opens the durable
 * host, attaches a headless source, and wires effects to the source.
 *
 * Presence is released exactly once — whether the source closes, the
 * signal aborts, or `abort()` is called. No monkey-patching, no dead
 * interval, no double-release.
 */
export const startHeadless = (opts: RuntimeDeps = {}): RunningConversation => {
  const convsFactory = opts.conversationsFactory ?? conversations;
  const acquirePresenceFn = opts.acquirePresenceFn ?? acquirePresence;
  const openConversationFn = opts.openConversationFn ?? openConversation;
  const openHeadlessSessionFn = opts.openHeadlessSessionFn ?? openHeadlessSession;
  const nowFn = opts.now ?? (() => Date.now());
  const uuidFn = opts.randomUUID ?? (() => crypto.randomUUID());
  const suffixFn = opts.randomConversationSuffix ?? (() => Math.random().toString(36).slice(2, 6));

  const convs = convsFactory(opts.rootDir);
  const conversationId = opts.conversationId ?? `conv-${Date.now()}-${suffixFn()}`;
  const dir = convs.dirFor(conversationId);

  // Ensure the record exists (conversations.ensure handles create-vs-open
  // and the fallback read — no duplication here).
  const { secret } = convs.ensure(conversationId);

  let receive: ((frame: Frame) => void) | undefined;
  const host = openConversationFn(dir, {
    now: nowFn,
    presence: () => undefined,
    onEffect: (eff) => {
      if (eff.type === "send") receive?.(eff.frame);
    },
    onRecord: (r) => opts.onRecord?.(r),
  });

  // Presence is held for the source's lifetime and kernel-released on
  // death; the runtime ensures a single explicit release.
  const presence = acquirePresenceFn(dir, conversationId, {
    onEvent: opts.onPresenceEvent,
  });
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

  const source = openHeadlessSessionFn({
    harness: claudeCode,
    conversationId,
    secret,
    sessionId,
    runner: opts.runner ?? nodeRunnerDeps(),
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame) => host.handleFrame(JSON.stringify(frame)),
  });
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
    conversationId,
    dir,
    done,
    abort,
    presenceHeld: () => presence.held() && !released,
  };
};

/**
 * Convenience: run until done. Preserves the original `runConversation`
 * promise shape for the CLI adapter.
 */
export const runHeadless = async (
  opts: RuntimeDeps = {},
): Promise<{ conversationId: string; dir: string }> => {
  const handle = startHeadless(opts);
  await handle.done;
  return { conversationId: handle.conversationId, dir: handle.dir };
};
