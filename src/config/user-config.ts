import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isProfile, SETTINGS_FIELDS, type Settings } from "../protocol/driver-settings.js";
import { isDriverField, isDriverHarness } from "../store/driver-preference.js";

export type { Settings } from "../protocol/driver-settings.js";
export interface ConfigLocation {
  readonly home?: string;
  readonly xdgConfigHome?: string;
}
export interface UserConfig {
  readonly defaults: Settings;
  readonly path: string;
  readonly recordsDir: string;
}
export class ConfigurationError extends Error {
  readonly code = "E-HUB-03";
}
const BUILT_INS: Settings = {
  effort: "high",
  harness: "claude",
  model: "opus",
  profile: "headless-turn",
};

export function readUserConfig(location: ConfigLocation = {}): UserConfig {
  const home = location.home ?? homedir();
  const xdg = location.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const path = join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "lucid/config.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { defaults: { ...BUILT_INS }, path, recordsDir: join(home, ".lucid/records") };
    throw new ConfigurationError(`Cannot read ${path}. Check its permissions.`);
  }
  let config: Record<string, unknown>;
  try {
    config = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    throw new ConfigurationError(`Invalid TOML in ${path}. Correct the configuration.`);
  }
  const fail = (reason: string): never => {
    throw new ConfigurationError(`${path}: ${reason}`);
  };
  if (config.version !== 1) fail("version must be 1");
  for (const key of Object.keys(config))
    if (!["version", "records_dir", "defaults"].includes(key)) fail(`unknown field ${key}`);
  const defaults = config.defaults ?? {};
  if (typeof defaults !== "object" || Array.isArray(defaults)) fail("defaults must be a table");
  for (const [key, value] of Object.entries(defaults)) {
    if (!(SETTINGS_FIELDS as readonly string[]).includes(key))
      fail(`unknown defaults field ${key}`);
    if (!isDriverField(value)) fail(`invalid defaults.${key}`);
  }
  const selected = { ...BUILT_INS, ...defaults };
  if (!isDriverHarness(selected.harness)) fail("unknown harness");
  if (!isProfile(selected.profile)) fail("unknown profile");
  const rawRoot = config.records_dir ?? "~/.lucid/records";
  const recordsDir =
    typeof rawRoot === "string" && rawRoot.startsWith("~/")
      ? join(home, rawRoot.slice(2))
      : rawRoot;
  if (typeof recordsDir !== "string" || !isAbsolute(recordsDir))
    return fail("records_dir must be an absolute path or begin with ~/");
  return { defaults: selected, path, recordsDir };
}
export function resolveRecordRoot(
  explicit: string | undefined,
  config: UserConfig | (() => UserConfig),
  environment = process.env.LUCID_ROOT,
): string {
  return resolve(
    explicit ?? environment ?? (typeof config === "function" ? config() : config).recordsDir,
  );
}
