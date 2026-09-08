import {
  diagnosticMessage,
  failureDiagnostic,
  selectionDiagnostic,
  selectionProblem,
} from "../harness/compatibility.js";
import { verifiedExecutable } from "../harness/inspection-facts.js";
import type { HarnessRunner } from "../harness/runner.js";
import { ownerPresence, terminalPresence } from "../process-owner.js";
import type { ChannelState } from "../protocol/reducer.js";
import { preferenceState } from "../store/driver-preference.js";
import { managedPrerequisite } from "../store/managed-readiness.js";
import { readRecordMetadata } from "../store/record-identity.js";
import { locationProjection } from "../store/settings.js";

interface AvailableRecovery {
  readonly actions: readonly ("retry" | "continue-fresh")[];
  readonly reason: string | null;
}

export const recoveryStamp = (dir: string, state: ChannelState): string =>
  managedPrerequisite(dir, state, "E-HUB-03");

/** Probe start/resume support, never run a task or summary from a read request. */
export function createRecoveryAvailability(
  runner: () => HarnessRunner,
  now: () => number = Date.now,
) {
  const cache = new Map<
    string,
    { readonly at: number; readonly result: Promise<AvailableRecovery> }
  >();
  return async (dir: string, state: ChannelState): Promise<AvailableRecovery> => {
    if (
      terminalPresence(state.terminalParticipations, (owner) =>
        owner ? ownerPresence(owner) : undefined,
      ) !== false
    )
      return {
        actions: [],
        reason:
          "The terminal owner is still present or cannot be verified. Wait for it to exit before recovery.",
      };
    const key = `${dir}:${recoveryStamp(dir, state)}`;
    const prior = cache.get(key);
    if (prior && now() - prior.at < 1500) return prior.result;
    const result = (async (): Promise<AvailableRecovery> => {
      const saved = preferenceState(dir);
      const choice = saved.preference;
      const location = locationProjection(readRecordMetadata(dir));
      if (location.status !== "available" || !location.workingDirectory)
        return { actions: [], reason: "Choose an available working folder before recovery." };
      if (saved.error || !choice?.model || !choice.effort || !choice.profile)
        return { actions: [], reason: "Complete the selected driver settings before recovery." };
      const profile = choice.profile === "interactive" ? "headless-turn" : choice.profile;
      const current = state.nativeSessions[choice.harness];
      const resume = state.harnessSessions[choice.harness];
      const cwd = location.workingDirectory;
      const inspect = (native: string | undefined) =>
        runner().inspect(choice.harness, {
          diagnosticOrigin: "execution-check",
          model: choice.model,
          effort: choice.effort,
          provider: choice.provider,
          runtime: { cwd, profile, resume: native },
        });
      try {
        const fresh = await inspect(undefined);
        if (
          !verifiedExecutable(fresh.runtime?.executable, fresh.verifiedAgainst) ||
          (profile === "headless-session" && !fresh.session)
        )
          return {
            actions: [],
            reason: diagnosticMessage(
              selectionDiagnostic(fresh, choice, runner().installation, "execution-check", false) ??
                selectionProblem(
                  choice,
                  runner().installation,
                  "selection-unsupported",
                  "the selected mode cannot be verified",
                  "execution-check",
                ),
            ),
          };
        if (resume === undefined) return { actions: ["retry", "continue-fresh"], reason: null };
        if (!current?.current || current.sessionId !== resume)
          return {
            actions: ["continue-fresh"],
            reason:
              "Native resume identity is unverified. A new session can receive the recorded context.",
          };
        let recallError: unknown;
        const recalled = await inspect(resume).catch((error) => {
          recallError = error;
          return null;
        });
        const supported =
          recalled !== null &&
          verifiedExecutable(recalled.runtime?.executable, recalled.verifiedAgainst) &&
          recalled.runtime?.resume.status === "supported";
        const diagnostic = recalled
          ? selectionDiagnostic(
              recalled,
              choice,
              runner().installation,
              "execution-check",
              verifiedExecutable(recalled.runtime?.executable, recalled.verifiedAgainst) !== null,
            )
          : failureDiagnostic(recallError);
        return {
          actions: supported ? ["retry", "continue-fresh"] : ["continue-fresh"],
          reason: supported
            ? null
            : `${diagnostic ? `${diagnosticMessage(diagnostic)} ` : ""}Native resume is unavailable. A new session can receive the recorded context.`,
        };
      } catch (error) {
        return {
          actions: [],
          reason: diagnosticMessage(
            failureDiagnostic(error) ??
              selectionProblem(
                choice,
                undefined,
                "inspection-unavailable",
                "the selected route could not be inspected for recovery",
                "execution-check",
              ),
          ),
        };
      }
    })();
    cache.set(key, { at: now(), result });
    if (cache.size > 100) cache.delete(cache.keys().next().value ?? "");
    return result;
  };
}
