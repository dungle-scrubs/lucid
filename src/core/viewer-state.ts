/**
 * The `/__lucid/state` assembly (plan 05, M3.1 / DF-1): the whole viewer
 * payload - fold, attendant resolution, presence, resume command,
 * settings-aware affordances, and the context/selection spreads - derived from
 * `paths` plus one host fact.
 *
 * Extracted from session-host.ts so the assembly is one module's concern. Core
 * already owns every module it composes (`payload`, `presence`, `attendant`,
 * `context`, `settings`; `readSelection` from launch); the one server fact -
 * how many agents are listening RIGHT NOW - enters as a THUNK read at
 * response-build time, so an agent connecting mid-request is still counted. A
 * pre-evaluated number is a silent behavioral regression (D-006): the count
 * would be the value when the request STARTED, not when the response is built.
 *
 * This module MUST NOT import from `src/server`.
 */
import { artifactAttendant, readLastAttendant } from "./attendant.ts";
import { readContextSidecar } from "./context.ts";
import { sessionState } from "./log.ts";
import type { SessionPaths } from "./paths.ts";
import { assemblePayload } from "./payload.ts";
import {
  harnessSessionId,
  type HarnessPresence,
  interactiveResumeCommand,
  presenceFor,
} from "./presence.ts";
import { readSettingsCached } from "./settings.ts";
import { readSelection } from "./selection-sidecar.ts";
import type { AttendantPresence, StateResponse } from "../protocol/wire.ts";

/** The one fact the host owns that core cannot derive: how many agents are
 *  subscribed right now. A thunk, not a number, so it is read at response-build
 *  time and an agent connecting mid-assembly is counted. */
export interface ViewerStateHost {
  readonly agentsListening: () => number;
}

const attendantPresenceOf = (live: HarnessPresence | undefined): AttendantPresence | null =>
  live
    ? {
        interactive: live.interactive,
        ...(live.status ? { status: live.status } : {}),
        ...(live.cwd ? { cwd: live.cwd } : {}),
      }
    : null;

/**
 * Assemble the `/__lucid/state` response: the folded payload plus viewer
 * presence (last attendant, lifecycle, resumability, context/selection). The
 * same resolution the attend engine uses for `target` and `knownSessionId`, so
 * the panel's idea of whose conversation this is can never differ from the
 * hub's, and the panel cannot promise a turn the engine will refuse.
 */
export const viewerState = async (
  paths: SessionPaths,
  host: ViewerStateHost,
): Promise<StateResponse> => {
  const state = await sessionState(paths);
  const payload = await assemblePayload(
    paths,
    state,
    state.status === "ended" ? "ended" : state.status === "suspended" ? "suspended" : "feedback",
    { annotations: state.annotations, messages: state.messages, reverts: state.reverts },
  );
  // Who last took delivery, from the advisory sidecars: display data for the
  // chrome's resume affordance, never something the server executes.
  const attendant = await readLastAttendant(paths);
  // Is that conversation open in a terminal right now? Resolved per request.
  // The SAME resolution the attend engine uses, so the panel cannot differ.
  const target = await artifactAttendant(paths, state.sessionHistory);
  const stampedHarness = [...state.sessionHistory].reverse().find((r) => r.harness);
  const presence = await presenceFor(target, paths.artifactDir);
  const contextUsage = await readContextSidecar(paths);
  const selection = await readSelection(paths);
  // Resumable = the engine has something to re-enter.
  const knownSessionId =
    target?.sessionId ??
    harnessSessionId({
      ...(target?.resume ? { resume: target.resume } : {}),
      artifactDir: paths.artifactDir,
    });
  const resumable = knownSessionId !== undefined;
  // A command the human can paste, offered whenever the session is KNOWN. The
  // sidecar's own command wins; recorded first because it carries the agent's
  // own flags.
  const settings = await readSettingsCached();
  const resumeCommand =
    attendant?.resume ??
    (target?.harness && knownSessionId
      ? interactiveResumeCommand(target.harness, knownSessionId, { yolo: settings.resumeYolo })
      : undefined);
  const attendantPresence = attendantPresenceOf(presence);
  return {
    ...payload,
    // The LIFECYCLE, beside the wait outcome `payload.status` carries. The
    // viewer drives every "is this session live" affordance off this.
    lifecycle: state.status,
    // Read at response-build time (D-006): an agent subscribing while the
    // assembly ran is counted.
    agentsListening: host.agentsListening(),
    resumable,
    ...(attendantPresence ? { attendantPresence } : {}),
    // The sidecar when there is one (it carries the resume command and the
    // attending session's model/effort); otherwise the harness the LOG records,
    // so a fresh artifact still NAMES its agent.
    ...(attendant
      ? {
          lastAttendant: {
            harness: attendant.harness,
            at: attendant.at,
            ...(resumeCommand ? { resume: resumeCommand } : {}),
            ...(attendant.model ? { model: attendant.model } : {}),
            ...(attendant.effort ? { effort: attendant.effort } : {}),
          },
        }
      : stampedHarness
        ? {
            lastAttendant: {
              harness: stampedHarness.harness,
              at: stampedHarness.lastAt,
              ...(resumeCommand ? { resume: resumeCommand } : {}),
            },
          }
        : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(selection ? { selection } : {}),
  };
};
