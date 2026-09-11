import { createHash } from "node:crypto";
import { hasUnresolvedOffer } from "../protocol/connection.js";
import type { ExecutionHold } from "../protocol/execution.js";
import { hasUnsettledExecution } from "../protocol/execution.js";
import type { ChannelState } from "../protocol/reducer.js";
import { preferenceState } from "./driver-preference.js";
import { readRecordMetadata } from "./record-identity.js";
import { locationProjection } from "./settings.js";

/** Holds compare material prerequisites, never their own log sequence. */
export function managedPrerequisite(
  dir: string,
  state: ChannelState,
  code: ExecutionHold["code"],
): string {
  const meta = readRecordMetadata(dir);
  const location = locationProjection(meta);
  const settings = preferenceState(dir);
  const native = settings.preference
    ? state.nativeSessions[settings.preference.harness]
    : undefined;
  const parts =
    code === "E-HUB-04"
      ? [meta.locationRevision, location]
      : [settings, meta.locationRevision, location, native?.current, native?.sessionId];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** A held failure needs an action; corrected folder/settings holds can wake. */
export function managedCandidates(
  dir: string,
  state: ChannelState,
  heads: ReadonlyMap<string, number> = new Map(),
): readonly string[] {
  // Bound conversations require same-session admission before any executor may start.
  if (state.connection) return [];
  if (
    Object.values(state.executions).some(
      (entry) => entry.kind === "attempt-ended" && entry.outcome.kind === "uncertain",
    )
  )
    return [];
  return eligibleExecutions(dir, state, heads);
}

/** Eligibility does not grant an executor lease or authorize native dispatch. */
export function nativeInputCandidates(
  dir: string,
  state: ChannelState,
  heads: ReadonlyMap<string, number>,
): readonly string[] {
  if (!state.connection || hasUnresolvedOffer(state.connection) || hasUnsettledExecution(state))
    return [];
  const managed = new Set(eligibleExecutions(dir, state, heads));
  return state.inputs
    .filter(
      (input) =>
        !Object.hasOwn(state.appliedInputs, input.id) &&
        input.rejections === 0 &&
        (!Object.hasOwn(state.executions, input.id) || managed.has(input.id)),
    )
    .sort((a, b) => a.seq - b.seq)
    .map((input) => input.id);
}

function eligibleExecutions(
  dir: string,
  state: ChannelState,
  heads: ReadonlyMap<string, number>,
): readonly string[] {
  const prerequisites = new Map<ExecutionHold["code"], string>();
  const prerequisiteFor = (code: ExecutionHold["code"]): string => {
    const value = prerequisites.get(code) ?? managedPrerequisite(dir, state, code);
    prerequisites.set(code, value);
    return value;
  };
  return Object.entries(state.executions)
    .filter(([, entry]) => {
      if (
        entry.kind === "requested" ||
        entry.kind === "retry-authorized" ||
        entry.kind === "fresh-authorized" ||
        entry.kind === "attempt-started"
      )
        return true;
      if (entry.kind === "held" && entry.hold.code === "E-COMP-07") {
        const prior = entry.hold.comparison;
        return (
          prior !== undefined &&
          ((heads.get(prior.artifactId) ?? 0) > prior.failedHead ||
            Object.values(state.explicitAttachments).some((epoch) => epoch > prior.explicitEpoch))
        );
      }
      return (
        entry.kind === "held" &&
        (entry.hold.code === "E-HUB-03" || entry.hold.code === "E-HUB-04") &&
        entry.hold.prerequisite !== prerequisiteFor(entry.hold.code)
      );
    })
    .map(([id]) => id);
}
