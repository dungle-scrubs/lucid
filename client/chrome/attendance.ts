/**
 * Attendance and the working line: one owner for the four presence facts and
 * the eight-arm work-state union. Four components previously re-derived these
 * from six raw store slices; this module is the single derivation point.
 *
 * `attendance` answers "who is here and how" (interactive / listening /
 * spawnable / harness name / a mode label for the footer). `workingLine`
 * answers "what is the state of the work right now" as a tagged union in
 * precedence order (awaiting-ack > turn-ended > blocked > progress > fan-out >
 * stale > live > none).
 */

import type { AgentWorking } from "../../src/protocol/wire.ts";
import { workingClock, WORKING_GRACE_MS } from "./working.ts";

/** The store slices attendance reads. */
export interface AttendanceState {
  readonly attendantPresence: { readonly interactive: boolean } | null;
  readonly attend: boolean;
  readonly resumable: boolean;
  readonly lastAttendant: { readonly harness: string } | null;
  readonly agentsListening: number;
}

/** The named mode the attendance footer shows. */
export type AttendanceMode = "interactive" | "spawn" | "unattached" | "recorded";

export interface Attendance {
  readonly interactive: boolean;
  readonly listening: number;
  readonly spawnable: boolean;
  readonly harness: string;
  readonly mode: AttendanceMode;
}

export const attendance = (state: AttendanceState): Attendance => {
  const interactive = state.attendantPresence?.interactive === true;
  const spawnable = state.attend && state.resumable;
  const harness = state.lastAttendant?.harness ?? "the agent";
  return {
    harness,
    interactive,
    listening: state.agentsListening,
    mode: interactive
      ? "interactive"
      : spawnable
        ? "spawn"
        : state.attend
          ? "unattached"
          : "recorded",
    spawnable,
  };
};

/** The store slices workingLine reads. */
export interface WorkingLineState {
  readonly agentWorking: AgentWorking | null;
  readonly awaitingAck: ReadonlySet<string> | null;
  readonly lastTurnEnd: { readonly reason: string; readonly code: string } | null;
  readonly status: string;
  readonly annotationCount: number;
  readonly messageCount: number;
}

/** The eight-arm tagged union. Precedence: awaiting-ack > turn-ended > blocked
 *  > progress > fan-out > stale > live > none. */
export type WorkingLine =
  | {
      readonly kind: "awaiting-ack";
      readonly interactive: boolean;
      readonly listening: number;
      readonly spawnable: boolean;
      readonly harness: string;
    }
  | {
      readonly kind: "turn-ended";
      readonly reason: string;
      readonly code: string;
      readonly limit: string;
    }
  | { readonly kind: "blocked"; readonly text: string }
  | {
      readonly kind: "progress";
      readonly working: AgentWorking;
      readonly mm: number;
      readonly ss: string;
    }
  | {
      readonly kind: "fan-out";
      readonly working: AgentWorking;
      readonly mm: number;
      readonly ss: string;
      readonly total: number | undefined;
      readonly done: number | undefined;
    }
  | {
      readonly kind: "stale";
      readonly working: AgentWorking;
      readonly mm: number;
      readonly ss: string;
      readonly delivered: boolean;
      readonly total: number | undefined;
    }
  | {
      readonly kind: "live";
      readonly working: AgentWorking;
      readonly mm: number;
      readonly ss: string;
    }
  | { readonly kind: "none" };

/** The limit-reason table. Lives here so the turn-ended arm and any future
 *  consumer share one owner rather than re-deriving the wording. */
const limitReason = (code: string): string =>
  code === "weekly_limit"
    ? "weekly usage limit"
    : code === "session_limit"
      ? "session limit"
      : code === "credits"
        ? "available credits"
        : code === "quota"
          ? "provider quota"
          : "usage limit";

export const workingLine = (state: WorkingLineState, now: number): WorkingLine => {
  const { agentWorking: working, awaitingAck, lastTurnEnd, status } = state;

  // 1. Awaiting-ack: feedback is in the log, no working window yet, nothing new
  // to render. Fills the gap between send and the agent's first ack.
  if (!working && awaitingAck && awaitingAck.size > 0 && status === "active") {
    return {
      harness: "the agent",
      interactive: false,
      kind: "awaiting-ack",
      listening: 0,
      spawnable: false,
    };
  }

  // 2. Turn-ended: the agent ran, stopped, and produced nothing new.
  if (!working && lastTurnEnd && status === "active") {
    return {
      code: lastTurnEnd.code,
      kind: "turn-ended",
      limit: limitReason(lastTurnEnd.code),
      reason: lastTurnEnd.reason,
    };
  }

  // 3-8: all require a working window and active status.
  if (!working || status !== "active") {
    return { kind: "none" };
  }

  const { stale, mm, ss } = workingClock(working, now);

  // 3. Blocked: the turn is waiting on a human, not slow or dead.
  if (working.blocked) {
    return { kind: "blocked", text: working.blocked };
  }

  const progress = working.progress;

  // 4. Progress (single agent narrating phases, no parallelism).
  if (progress && !stale && progress.total === undefined) {
    return { kind: "progress", mm, ss, working };
  }

  // 5. Fan-out (multiple parallel agents).
  if (progress && !stale) {
    return { done: progress.done, kind: "fan-out", mm, ss, total: progress.total, working };
  }

  // 6. Stale: quiet past the grace window.
  if (stale) {
    return {
      delivered: state.annotationCount > 0 || state.messageCount > 0,
      kind: "stale",
      mm,
      ss,
      total: progress?.total,
      working,
    };
  }

  // 7. Live: working, fresh, no progress narration.
  return { kind: "live", mm, ss, working };
};

export { WORKING_GRACE_MS };
