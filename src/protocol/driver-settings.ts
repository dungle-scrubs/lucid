import type { HarnessName } from "./frames.js";

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
