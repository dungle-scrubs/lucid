import { createHash } from "node:crypto";
import type { ExecutionHold } from "../protocol/execution.js";
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
  const prerequisites = new Map<ExecutionHold["code"], string>();
  const prerequisiteFor = (code: ExecutionHold["code"]): string => {
    const value = prerequisites.get(code) ?? managedPrerequisite(dir, state, code);
    prerequisites.set(code, value);
    return value;
  };
  if (
    Object.values(state.executions).some(
      (entry) => entry.kind === "attempt-ended" && entry.outcome.kind === "uncertain",
    )
  )
    return [];
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
