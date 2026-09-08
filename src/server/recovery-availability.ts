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
export function createRecoveryAvailability(runner: () => HarnessRunner) {
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
    if (prior && Date.now() - prior.at < 1500) return prior.result;
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
            reason:
              "The selected executable or mode cannot be verified. Repair the installation or change settings.",
          };
        if (resume === undefined) return { actions: ["retry", "continue-fresh"], reason: null };
        if (!current?.current || current.sessionId !== resume)
          return {
            actions: ["continue-fresh"],
            reason:
              "Native resume identity is unverified. A new session can receive the recorded context.",
          };
        const recalled = await inspect(resume).catch(() => null);
        const supported =
          recalled !== null &&
          verifiedExecutable(recalled.runtime?.executable, recalled.verifiedAgainst) &&
          recalled.runtime?.resume.status === "supported";
        return {
          actions: supported ? ["retry", "continue-fresh"] : ["continue-fresh"],
          reason: supported
            ? null
            : "Native resume is unavailable. A new session can receive the recorded context.",
        };
      } catch {
        return {
          actions: [],
          reason:
            "The selected route cannot start. Repair the executable or change settings before recovery.",
        };
      }
    })();
    cache.set(key, { at: Date.now(), result });
    if (cache.size > 100) cache.delete(cache.keys().next().value ?? "");
    return result;
  };
}
