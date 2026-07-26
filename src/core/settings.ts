import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Lucid's own settings, at `~/.lucid/settings.json`.
 *
 * Distinct from the harness registry (which describes how to RUN harnesses):
 * this is how the human wants Lucid itself to behave. Absent file, unreadable
 * file, unknown keys - all fall back to the documented defaults, because a
 * settings file is a convenience and must never be a way to break the app.
 */

export interface LucidSettings {
  /**
   * Add each harness's skip-permissions flag to the resume command the panel
   * offers for copying.
   *
   * Defaults to TRUE: that command exists to drop you back into a conversation
   * you were already having about your own artifact, and being re-prompted for
   * permission on every tool call is the thing it is meant to save you.
   */
  readonly resumeYolo: boolean;
}

export const DEFAULT_SETTINGS: LucidSettings = { resumeYolo: true };

/** Where settings live. Injectable for tests. */
export const settingsFilePath = (path?: string): string => {
  if (path) return path;
  if (process.env.LUCID_SETTINGS) return process.env.LUCID_SETTINGS;
  return resolve(homedir(), ".lucid", "settings.json");
};

export const readSettings = async (path?: string): Promise<LucidSettings> => {
  try {
    const parsed = JSON.parse(await readFile(settingsFilePath(path), "utf8")) as Partial<
      Record<keyof LucidSettings, unknown>
    >;
    return {
      resumeYolo:
        typeof parsed?.resumeYolo === "boolean" ? parsed.resumeYolo : DEFAULT_SETTINGS.resumeYolo,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
};

/**
 * The settings sweep costs a file read, and every state poll of every open tab
 * would otherwise pay it. Short TTL so editing the file takes effect without a
 * restart.
 */
const CACHE_MS = 2000;
let cached: { at: number; path: string; value: LucidSettings } | undefined;

export const readSettingsCached = async (path?: string): Promise<LucidSettings> => {
  const file = settingsFilePath(path);
  const now = Date.now();
  if (cached && cached.path === file && now - cached.at < CACHE_MS) return cached.value;
  const value = await readSettings(file);
  cached = { at: now, path: file, value };
  return value;
};

/** Drop the settings cache (tests, and anything that must not read a stale one). */
export const resetSettingsCache = (): void => {
  cached = undefined;
};
