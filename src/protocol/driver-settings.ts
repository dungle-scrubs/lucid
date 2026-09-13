import type { HarnessName } from "./frames.js";
import { HARNESS_NAMES, isWireId } from "./frames.js";
import { HubError } from "./hub-errors.js";

export const PROFILES = ["headless-turn", "headless-session", "interactive"] as const;
export type SelectedProfile = (typeof PROFILES)[number];
export const SETTINGS_FIELDS = ["harness", "model", "effort", "profile", "provider"] as const;
export interface Settings {
  readonly effort: string;
  readonly harness: HarnessName;
  readonly model: string;
  readonly profile: SelectedProfile;
  readonly provider?: string;
}
export function isProfile(value: unknown): value is SelectedProfile {
  return typeof value === "string" && (PROFILES as readonly string[]).includes(value);
}

export function settingsShape(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HubError("Expected an object.", "E-HUB-03");
  const choice = value as Record<string, unknown>;
  if (
    typeof choice.harness !== "string" ||
    !(HARNESS_NAMES as readonly string[]).includes(choice.harness)
  )
    throw new HubError("Choose a supported harness.", "E-HUB-03");
  for (const field of ["model", "effort", ...(choice.provider === undefined ? [] : ["provider"])]) {
    if (typeof choice[field] !== "string" || !isWireId(choice[field]))
      throw new HubError(
        `${field} must be a nonempty, control-free string of at most 128 characters.`,
        "E-HUB-03",
      );
  }
  if (!isProfile(choice.profile)) throw new HubError("Choose a supported mode.", "E-HUB-03");
  return {
    harness: choice.harness as HarnessName,
    model: String(choice.model),
    effort: String(choice.effort),
    profile: choice.profile,
    ...(choice.provider === undefined ? {} : { provider: String(choice.provider) }),
  };
}

/** The saved choice and its revision, independent of the driver currently running. */
export interface DriverPreference {
  readonly profile?: SelectedProfile;
  readonly revision?: number;
  readonly v: 1;
  readonly harness: HarnessName;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}
