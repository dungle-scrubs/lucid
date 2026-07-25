import { NotFoundError } from "../errors.ts";
import { discoverLiveServer, loopbackFetch } from "../server/discovery.ts";
import { parseCursor } from "./cursor.ts";
import {
  foldLog,
  type AnnotationRecord,
  type FoldedState,
  type ForkRecord,
  type MessageRecord,
  type RevertRecord,
} from "./fold.ts";
import { readEvents } from "./log.ts";
import type { SessionPaths } from "./paths.ts";
import { assemblePayload, type PayloadStatus, type WaitPayload } from "./payload.ts";

export interface WaitOptions {
  readonly since?: string;
  /** Bounded blocking window in ms before returning `waiting`. */
  readonly timeoutMs?: number;
  /** Poll interval in ms. */
  readonly pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Heartbeat fallback between SSE wakes (so it still works if the stream drops). */
const HEARTBEAT_MS = 1500;
const LIVENESS_EVERY = 4; // re-handshake every N wakes

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Push-woken wait (RFC §6 refinement). Subscribes to the server's SSE stream
 * purely as a wake signal; the log stays the source of truth. The server is
 * not in the read path - on any event we re-read the log for truth. Reconnects
 * automatically if the stream drops, so push latency is preserved across a
 * transient disconnect instead of degrading to the heartbeat for the rest of
 * the wait. Falls back to a heartbeat if the stream is unavailable, so `wait`
 * still works without it.
 */
interface Waker {
  next(ms: number): Promise<void>;
  close(): void;
}

/** Backoff between SSE reconnect attempts, capped. */
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 3000;

const createWaker = (port: number, base = ""): Waker => {
  let pending = false;
  let resolveWake: (() => void) | null = null;
  let closed = false;
  const controller = new AbortController();
  const signal = () => {
    pending = true;
    if (resolveWake) {
      resolveWake();
      resolveWake = null;
    }
  };
  // One persistent reader loop that reconnects on stream end/error. This keeps
  // push-woken latency after a dropped stream instead of silently relying on
  // the heartbeat for the remainder of the wait window.
  void (async () => {
    let backoff = RECONNECT_BASE_MS;
    while (!closed) {
      try {
        // `base` scopes the stream to the session's mount on a shared server
        // (the hub daemon); a bare path there would be a JSON 404 whose body
        // closes immediately - read as an endless wake/reconnect loop.
        const res = await loopbackFetch(port, `${base}/__lucid/events?role=agent`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`no stream (HTTP ${res.status})`);
        const reader = res.body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
          signal(); // any frame wakes us; we re-read the log for truth
        }
        // Stream ended cleanly (server is shutting down). Reconnect in case it
        // restarts; the liveness handshake in runWait will eventually detect a
        // truly-dead server and report suspended.
        backoff = RECONNECT_BASE_MS;
      } catch {
        // stream ended/aborted/errored; heartbeat carries this wake, then we retry
      }
      if (closed) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  })();
  return {
    next: (ms: number) => {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return Promise.race([new Promise<void>((r) => (resolveWake = r)), sleep(ms)]).then(() => {
        resolveWake = null;
      });
    },
    close: () => {
      closed = true;
      controller.abort();
    },
  };
};

const sliceDelta = <T extends { readonly seq: number }>(
  items: readonly T[],
  cursor: number | undefined,
): readonly T[] => (cursor === undefined ? items : items.filter((i) => i.seq > cursor));

const buildFromState = (
  paths: SessionPaths,
  state: FoldedState,
  status: PayloadStatus,
  annotations: readonly AnnotationRecord[],
  messages: readonly MessageRecord[],
  reverts: readonly RevertRecord[] = [],
  forks: readonly ForkRecord[] = [],
): Promise<WaitPayload> =>
  assemblePayload(paths, state, status, { annotations, forks, messages, reverts });

/**
 * Core `wait` semantics (RFC §6, state machine). Tails the log directly (the
 * server is only a writer; D-051). No cursor -> full folded current-segment
 * state for bootstrap. With a cursor -> drain (feedback / version-only
 * `waiting`) or block until feedback / end / suspend / window.
 */
export const runWait = async (
  paths: SessionPaths,
  options: WaitOptions = {},
): Promise<WaitPayload> => {
  const cursor = parseCursor(options.since);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heartbeatMs = options.pollMs ?? HEARTBEAT_MS;

  const initial = foldLog((await readEvents(paths.logPath)).events);
  if (initial.status === "none") {
    throw new NotFoundError({
      message: `No Lucid session for ${paths.artifactPath}`,
      detail: { path: paths.artifactPath },
    });
  }
  if (initial.status === "ended") {
    return buildFromState(paths, initial, "ended", [], []);
  }

  // No cursor -> immediate full folded state for cross-agent bootstrap (D-056).
  if (cursor === undefined) {
    const hasContent =
      initial.annotations.length > 0 ||
      initial.forks.length > 0 ||
      initial.messages.length > 0 ||
      initial.reverts.length > 0 ||
      initial.questions.length > 0 ||
      initial.reviewResolved;
    if (initial.status === "suspended") {
      return buildFromState(
        paths,
        initial,
        "suspended",
        initial.annotations,
        initial.messages,
        initial.reverts,
        initial.forks,
      );
    }
    const live = await discoverLiveServer(paths);
    const status: PayloadStatus = !live ? "suspended" : hasContent ? "feedback" : "waiting";
    return buildFromState(
      paths,
      initial,
      status,
      initial.annotations,
      initial.messages,
      initial.reverts,
      initial.forks,
    );
  }

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  let wakes = 0;
  let liveKnown = true;
  let waker: Waker | undefined;

  try {
    for (;;) {
      const state = foldLog((await readEvents(paths.logPath)).events);

      if (state.status === "ended") return buildFromState(paths, state, "ended", [], []);
      if (state.status === "suspended") {
        return buildFromState(
          paths,
          state,
          "suspended",
          state.annotations,
          state.messages,
          state.reverts,
          state.forks,
        );
      }

      // Liveness: an ACTIVE fold with a dead server reports suspended (D-038).
      if (wakes % LIVENESS_EVERY === 0) {
        const live = await discoverLiveServer(paths);
        liveKnown = live !== undefined;
        if (live && !waker) waker = createWaker(live.port, live.base ?? "");
      }
      if (!liveKnown) {
        return buildFromState(
          paths,
          state,
          "suspended",
          state.annotations,
          state.messages,
          state.reverts,
          state.forks,
        );
      }

      const deltaAnnotations = sliceDelta(state.annotations, cursor);
      const deltaForks = sliceDelta(state.forks, cursor);
      const deltaMessages = sliceDelta(state.messages, cursor);
      const deltaReverts = sliceDelta(state.reverts, cursor);
      const deltaHumanMessages = deltaMessages.filter((m) => m.role === "human");
      const newAnswers = state.questions.some((q) => q.answered && (q.answerSeq ?? 0) > cursor);
      const reviewResolvedAfterCursor = state.reviewResolved && state.reviewToggleSeq > cursor;

      // Feedback = located annotations, fork requests, human messages, reverts,
      // answered questions, or an approve signal. An agent's own reply / version
      // / its own just-posted question do not self-trigger.
      if (
        deltaAnnotations.length > 0 ||
        deltaForks.length > 0 ||
        deltaHumanMessages.length > 0 ||
        deltaReverts.length > 0 ||
        newAnswers ||
        reviewResolvedAfterCursor
      ) {
        return buildFromState(
          paths,
          state,
          "feedback",
          deltaAnnotations,
          deltaMessages,
          deltaReverts,
          deltaForks,
        );
      }

      // Version-only delta (e.g. the authoring agent's own revision) -> waiting
      // (D-062). Acks are invisible here: an agent acknowledging delivery must
      // not wake itself or another waiting agent.
      if (state.lastNonAckSeq > cursor) {
        return buildFromState(paths, state, "waiting", [], []);
      }
      if (Date.now() >= deadline) {
        return buildFromState(paths, state, "waiting", [], []);
      }

      wakes += 1;
      // Push-woken: wakes instantly on an SSE frame, else after the heartbeat.
      await (waker ? waker.next(heartbeatMs) : sleep(heartbeatMs));
    }
  } finally {
    waker?.close();
  }
};
