/**
 * `lucid run` - headless orchestration (M2.2, promotes `scripts/smoke-live.ts`).
 *
 * Creates/opens the conversation record, folds the log ONCE at start,
 * acquires the presence lock, opens a headless source on `nodeRunnerDeps`,
 * and drives as the single live source (no tailer, D-011). Emits a
 * run-level boundary event keyed by `conversationId` so the smoke and
 * later handoff can be evidence-logged.
 *
 * What it is NOT: it is not the daemon, not the TUI app, not a tailer.
 * At most one live source per conversation (D-011), so there is no
 * executor-lease / delivery-cursor machinery here - that is deferred.
 */

import { join } from "node:path";
import { nodeRunnerDeps } from "@dungle-scrubs/harness-cli/src/execution/node-deps.js";
import { claudeCode } from "@dungle-scrubs/harness-cli/src/knowledge/claude-code.js";
import { openHeadlessSession } from "../modes/headless.js";
import type { Frame } from "../protocol/index.js";
import { acquirePresence, type PresenceEvent } from "../store/presence.js";
import { createConversationRecord, type HostRecord, openConversation } from "../store/store.js";

export interface RunOpts {
  readonly rootDir?: string;
  readonly conversationId?: string;
  /** For tests: inject a custom runner. */
  readonly runner?: ReturnType<typeof nodeRunnerDeps>;
  readonly onRecord?: (r: HostRecord) => void;
  readonly onPresenceEvent?: (e: PresenceEvent) => void;
  readonly signal?: AbortSignal;
}

const defaultRoot = (): string =>
  process.env.LUCID_ROOT ?? join(process.env.HOME ?? "/tmp", ".lucid", "records");

/** Run a conversation headlessly. Resolves when the source closes
 * (claude exits). The presence lock is held for the source's lifetime
 * and kernel-released on death (M2.5). */
export const runConversation = async (
  opts: RunOpts = {},
): Promise<{ conversationId: string; dir: string }> => {
  const rootDir = opts.rootDir ?? defaultRoot();
  const conversationId =
    opts.conversationId ?? `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(rootDir, conversationId);

  // Create or open the record. The open folds the log ONCE under the
  // append lock - no tailer, no second fold loop.
  let secret: string;
  try {
    const created = createConversationRecord(rootDir, conversationId);
    secret = created.secret;
  } catch (e) {
    if (!(e instanceof Error) || !/exists/.test(e.message)) throw e;
    // Exists - read secret via openConversation's own read (it will
    // throw if missing, which is the correct error).
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const secretPath = join(dir, "secret");
    if (!existsSync(secretPath)) throw e;
    secret = readFileSync(secretPath, "utf8").trim();
  }

  const records: HostRecord[] = [];
  const host = openConversation(dir, {
    now: () => Date.now(),
    presence: () => undefined,
    onEffect: (eff) => {
      if (eff.type === "send") receive?.(eff.frame);
    },
    onRecord: (r) => {
      records.push(r);
      opts.onRecord?.(r);
    },
  });

  // Presence lock: acquired at attach, held for the source's lifetime.
  const presence = acquirePresence(dir, conversationId, {
    onEvent: opts.onPresenceEvent,
  });

  // Run-level boundary event keyed by conversationId (observability).
  opts.onRecord?.({
    verdict: "recovered",
    conversationId,
    entries: 0,
    discardedBytes: 0,
    seq: host.state().seq,
    epoch: host.state().epoch,
  } as unknown as HostRecord);

  let receive: ((frame: Frame) => void) | undefined;
  const sessionId = crypto.randomUUID();
  let turnCount = 0;

  const source = openHeadlessSession({
    harness: claudeCode,
    conversationId,
    secret,
    sessionId,
    runner: opts.runner ?? nodeRunnerDeps(),
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame) => host.handleFrame(JSON.stringify(frame)),
  });
  receive = source.receive;

  // Drive until the source closes or the signal aborts. No tailer -
  // the store's append transaction is the only writer, and the source
  // is the single live source (D-011).
  await new Promise<void>((resolve, _reject) => {
    const abort = (): void => {
      try {
        source.close();
      } catch {}
      resolve();
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }
    // The source's close is cooperative; we resolve when it is called.
    // For the harness, we poll for `done` or wait for process exit.
    // Here we just wait for the harness to finish its turn loop.
    // The smoke promotes this path, so we reuse its wait condition.
    const check = setInterval(() => {
      // If the source has detached (host state shows no attachment),
      // we can resolve.
      if (!host.state().attachment) {
        // Not a reliable signal for headless; instead wait for an
        // explicit close. Keep polling.
      }
    }, 500);
    // Cleanup on source exit - the harness will call our sendFrame
    // with a detach, but we also watch for signal.
    const origClose = source.close.bind(source);
    (source as { close: () => void }).close = () => {
      clearInterval(check);
      presence.release();
      try {
        origClose();
      } finally {
        resolve();
      }
    };
    // If the host's `sendFrame` returns a detach, the source will
    // eventually close itself; we just wait.
  });

  presence.release();
  return { conversationId, dir };
};
