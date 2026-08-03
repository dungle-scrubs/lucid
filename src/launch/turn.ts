import {
  detectAuthFailure,
  detectUsageLimit,
  type AuthFailureKind,
  type UsageLimitKind,
} from "./limits.ts";

/**
 * Driving ONE headless turn.
 *
 * Three surfaces used to re-derive the same sequence - the fork launcher's
 * Shape-C resume, the hub's attend engine, the hub's create - and each one
 * decided for itself what a dead turn's output meant, whether the stall
 * watchdog applied, and whether the artifact's sticky selection reached the
 * argv. This module owns the parts that must not differ by call site; the
 * drivers keep the parts that are genuinely theirs (which batch to take, when
 * to stand down, what to tell the human).
 */

/**
 * Why a dead turn died: the two walls a harness can hit, and the turn-record
 * shape they map to.
 *
 * Both detectors run on every dead turn, because a consumer can want either
 * separately - the create dialog reports the usage wall and the auth wall as
 * distinct facts, since their remedies have nothing in common. `reason` and
 * `code` are the single ranking the RECORD carries when both could apply: a
 * usage wall outranks an auth wall, because a harness over its budget will
 * not authenticate its way back in.
 *
 * Identifiers throughout, never the harness's sentence (D-005): the line that
 * matched can carry a prompt, a filename or a customer's name, and both
 * consumers of a classification are retained.
 */
export interface TurnFailure {
  readonly usageLimit: UsageLimitKind | null;
  readonly authFailure: AuthFailureKind | null;
  /** The `agent_turn_ended` reason this diagnosis maps to. */
  readonly reason: "failed" | "usage_limit";
  /** The `agent_turn_ended` code (TURN_END_CODE charset), absent when the
   *  output named no wall at all. */
  readonly code?: string;
}

/** Turn a wall's kind into the log's identifier charset: the kinds are
 *  hyphenated on the warning wire, and `code` takes underscores. */
const asCode = (kind: string): string => kind.replaceAll("-", "_");

/**
 * What THIS run's output says about why the turn died. Callers pass the slice
 * belonging to their own run - the out-logs are append-mode and shared across
 * attempts, so classifying the whole file lets an earlier turn's wall be
 * reported as this one's.
 */
export const classifyTurnFailure = (output: string): TurnFailure => {
  const usageLimit = detectUsageLimit(output);
  const authFailure = detectAuthFailure(output);
  if (usageLimit !== null) {
    return { usageLimit, authFailure, reason: "usage_limit", code: asCode(usageLimit) };
  }
  if (authFailure !== null) {
    // Still `failed` - the closed reason set has no auth member, and the code
    // is what tells the two failures apart in the record. Namespaced, so an
    // auth kind and a limit kind can never collide on one identifier.
    return { usageLimit, authFailure, reason: "failed", code: `auth_${asCode(authFailure)}` };
  }
  return { usageLimit, authFailure, reason: "failed" };
};
