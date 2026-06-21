import type { Anchor } from "../anchors/anchor.ts";
import type { LogEvent } from "./events.ts";
import { maxSeq } from "./log.ts";

export type SessionStatus = "none" | "active" | "suspended" | "ended";

export interface AnnotationRecord {
  readonly id: string;
  readonly seq: number;
  readonly version: number;
  readonly target: Anchor;
  readonly note: string;
  readonly at: string;
}

export interface MessageRecord {
  readonly role: "human" | "agent";
  readonly seq: number;
  readonly text: string;
  readonly at: string;
  readonly refs?: readonly string[];
}

export interface VersionRef {
  readonly version: number;
  readonly hash: string;
  readonly path: string;
  readonly seq: number;
}

export interface FoldedState {
  readonly status: SessionStatus;
  /** Current lifecycle segment number (1-based). */
  readonly segment: number;
  /** Current artifact version (segment-scoped; resets to 1 each segment). */
  readonly version: number;
  readonly reviewResolved: boolean;
  /** seq of the last review_resolved/review_reopened toggle in the segment (0 if none). */
  readonly reviewToggleSeq: number;
  /** Live annotations of the current segment, in log order (D-056). */
  readonly annotations: readonly AnnotationRecord[];
  /** Conversation of the current segment, in log order. */
  readonly messages: readonly MessageRecord[];
  /** Version refs of the current segment (for snapshot lookup). */
  readonly versions: readonly VersionRef[];
  /** Artifact basename recorded at session_opened. */
  readonly artifact: string;
  /** Highest seq across the WHOLE log (nextCursor floor). */
  readonly highSeq: number;
  /** seq of the session_opened that begins the current segment. */
  readonly segmentStartSeq: number;
}

const LIFECYCLE = new Set([
  "session_opened",
  "session_resumed",
  "session_suspended",
  "session_ended",
]);

const statusFromLifecycle = (t: string): SessionStatus => {
  switch (t) {
    case "session_opened":
    case "session_resumed":
      return "active";
    case "session_suspended":
      return "suspended";
    case "session_ended":
      return "ended";
    default:
      return "none";
  }
};

/**
 * Fold the event log to current state. Lifecycle status derives from the latest
 * lifecycle event across the whole log (D-049); current version, reviewResolved,
 * the live annotation set, and the conversation derive from the latest segment
 * only (D-056). Earlier segments are read-only history.
 */
export const foldLog = (events: readonly LogEvent[]): FoldedState => {
  const highSeq = maxSeq(events);

  if (events.length === 0) {
    return {
      status: "none",
      segment: 0,
      version: 0,
      reviewResolved: false,
      reviewToggleSeq: 0,
      annotations: [],
      messages: [],
      versions: [],
      artifact: "",
      highSeq,
      segmentStartSeq: 0,
    };
  }

  // Latest lifecycle event anywhere -> status.
  let status: SessionStatus = "none";
  for (const e of events) if (LIFECYCLE.has(e.t)) status = statusFromLifecycle(e.t);

  // Current segment begins at the last session_opened.
  let segStart = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.t === "session_opened") segStart = i;
  }
  const segmentEvents = events.slice(segStart);
  const opened = segmentEvents[0];

  let segment = 1;
  let version = 1;
  let artifact = "";
  let segmentStartSeq = 0;
  const versions: VersionRef[] = [];
  const annotations: AnnotationRecord[] = [];
  const messages: MessageRecord[] = [];
  let reviewResolved = false;
  let reviewToggleSeq = 0;

  if (opened && opened.t === "session_opened") {
    segment = opened.segment;
    version = opened.version;
    artifact = opened.artifact;
    segmentStartSeq = opened.seq;
    versions.push({
      version: opened.version,
      hash: opened.hash,
      path: opened.path,
      seq: opened.seq,
    });
  }

  for (const e of segmentEvents) {
    switch (e.t) {
      case "version":
        version = e.version;
        versions.push({ version: e.version, hash: e.hash, path: e.path, seq: e.seq });
        break;
      case "annotation":
        annotations.push({
          id: e.id,
          seq: e.seq,
          version: e.version,
          target: e.target,
          note: e.note,
          at: e.at,
        });
        break;
      case "prompt":
        messages.push({ role: "human", seq: e.seq, text: e.text, at: e.at, refs: e.refs });
        break;
      case "agent_reply":
        messages.push({ role: "agent", seq: e.seq, text: e.text, at: e.at });
        break;
      case "review_resolved":
        reviewResolved = true;
        reviewToggleSeq = e.seq;
        break;
      case "review_reopened":
        reviewResolved = false;
        reviewToggleSeq = e.seq;
        break;
      default:
        break;
    }
  }

  return {
    status,
    segment,
    version,
    reviewResolved,
    reviewToggleSeq,
    annotations,
    messages,
    versions,
    artifact,
    highSeq,
    segmentStartSeq,
  };
};

/** Look up the version ref a given version number maps to within the segment. */
export const versionRef = (state: FoldedState, version: number): VersionRef | undefined =>
  state.versions.find((v) => v.version === version);
