import { createHash } from "node:crypto";
import type { NativeBinding } from "../protocol/connection.js";
import { hasUnsettledNativeWork, requiresNativeConnection } from "../protocol/connection.js";
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
  // Native publications require same-session admission before any executor may start.
  if (requiresNativeConnection(state)) return [];
  if (
    Object.values(state.executions).some(
      (entry) => entry.kind === "attempt-ended" && entry.outcome.kind === "uncertain",
    )
  )
    return [];
  return eligibleExecutions(dir, state, heads);
}

/** A hold follows material prerequisites; automatic continuation does not reset it. */
export function nativePreparationPrerequisite(
  dir: string,
  state: ChannelState,
  heads: ReadonlyMap<string, number>,
): string {
  const metadata = readRecordMetadata(dir);
  return createHash("sha256")
    .update(
      JSON.stringify({
        artifacts: [...heads].sort(([a], [b]) => a.localeCompare(b)),
        explicitListenerEpoch: state.connection?.explicitListenerEpoch ?? 0,
        location: {
          revision: metadata.locationRevision ?? 0,
          workingDirectory: metadata.workingDirectory ?? null,
        },
      }),
    )
    .digest("hex");
}

/** Only interfaces with a verified automatic worker integration are selected. */
export function workerNativeBinding(state: ChannelState): NativeBinding | undefined {
  const binding = state.connection?.binding;
  return binding?.interface === "codex-cli" ? binding : undefined;
}

/** Discovery requests a worker only for an integrated native interface. Execution
 * still requires fresh native-headless admission under the executor lock. */
export function workerCandidates(
  dir: string,
  state: ChannelState,
  heads: ReadonlyMap<string, number>,
): readonly string[] {
  return workerNativeBinding(state)
    ? nativeInputCandidates(dir, state, heads)
    : managedCandidates(dir, state, heads);
}

export function nativeInputCandidates(
  dir: string,
  state: ChannelState,
  heads: ReadonlyMap<string, number>,
): readonly string[] {
  if (!state.connection || hasUnsettledNativeWork(state)) return [];
  const managed = new Set(eligibleExecutions(dir, state, heads));
  let prerequisite: string | undefined;
  const unheld = (id: string): boolean => {
    const hold = state.connection?.heldInputs[id];
    if (!hold) return true;
    prerequisite ??= nativePreparationPrerequisite(dir, state, heads);
    return hold.prerequisite !== prerequisite;
  };
  return state.inputs
    .filter(
      (input) =>
        !Object.hasOwn(state.appliedInputs, input.id) &&
        input.rejections === 0 &&
        (!Object.hasOwn(state.executions, input.id) || managed.has(input.id)) &&
        unheld(input.id),
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
            (state.connection?.explicitListenerEpoch ?? 0) > prior.explicitEpoch ||
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
