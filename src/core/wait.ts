import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NotFoundError } from "../errors.ts";
import { discoverLiveServer } from "../server/discovery.ts";
import { parseCursor } from "./cursor.ts";
import { foldLog, type AnnotationRecord, type FoldedState, type MessageRecord } from "./fold.ts";
import { readEvents } from "./log.ts";
import type { SessionPaths } from "./paths.ts";
import { buildWaitPayload, type PayloadStatus, type WaitPayload } from "./payload.ts";

export interface WaitOptions {
  readonly since?: string;
  /** Bounded blocking window in ms before returning `waiting`. */
  readonly timeoutMs?: number;
  /** Poll interval in ms. */
  readonly pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 200;
const LIVENESS_EVERY = 10; // re-handshake every N polls

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sliceDelta = <T extends { readonly seq: number }>(
  items: readonly T[],
  cursor: number | undefined,
): readonly T[] => (cursor === undefined ? items : items.filter((i) => i.seq > cursor));

const buildFromState = async (
  paths: SessionPaths,
  state: FoldedState,
  status: PayloadStatus,
  annotations: readonly AnnotationRecord[],
  messages: readonly MessageRecord[],
): Promise<WaitPayload> => {
  const currentHtml = await readFile(paths.currentHtml, "utf8").catch(() => "");
  return buildWaitPayload({
    session: paths.artifactPath,
    state,
    status,
    currentHtml,
    snapshotAbsPath: (rel) => join(paths.sessionDir, rel),
    annotations,
    messages,
    nextSeq: state.highSeq,
  });
};

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
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

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
      initial.annotations.length > 0 || initial.messages.length > 0 || initial.reviewResolved;
    if (initial.status === "suspended") {
      return buildFromState(paths, initial, "suspended", initial.annotations, initial.messages);
    }
    const live = await discoverLiveServer(paths);
    const status: PayloadStatus = !live ? "suspended" : hasContent ? "feedback" : "waiting";
    return buildFromState(paths, initial, status, initial.annotations, initial.messages);
  }

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  let polls = 0;
  let liveKnown = true;

  for (;;) {
    const state = foldLog((await readEvents(paths.logPath)).events);

    if (state.status === "ended") return buildFromState(paths, state, "ended", [], []);
    if (state.status === "suspended") {
      return buildFromState(paths, state, "suspended", state.annotations, state.messages);
    }

    // Liveness: an ACTIVE fold with a dead server reports suspended (D-038).
    if (polls % LIVENESS_EVERY === 0) {
      liveKnown = (await discoverLiveServer(paths)) !== undefined;
    }
    if (!liveKnown) {
      return buildFromState(paths, state, "suspended", state.annotations, state.messages);
    }

    const deltaAnnotations = sliceDelta(state.annotations, cursor);
    const deltaMessages = sliceDelta(state.messages, cursor);
    const deltaHumanMessages = deltaMessages.filter((m) => m.role === "human");
    const reviewResolvedAfterCursor = state.reviewResolved && state.reviewToggleSeq > cursor;

    // Feedback = located annotations, human messages, or an approve signal.
    // An agent's own reply (or a version-only delta) does not self-trigger.
    if (deltaAnnotations.length > 0 || deltaHumanMessages.length > 0 || reviewResolvedAfterCursor) {
      return buildFromState(paths, state, "feedback", deltaAnnotations, deltaMessages);
    }

    // Version-only delta (e.g. the authoring agent's own revision) -> waiting (D-062).
    if (state.highSeq > cursor) {
      return buildFromState(paths, state, "waiting", [], []);
    }

    if (Date.now() >= deadline) {
      return buildFromState(paths, state, "waiting", [], []);
    }
    polls += 1;
    await sleep(pollMs);
  }
};
