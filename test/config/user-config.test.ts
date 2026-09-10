import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUserConfig, resolveRecordRoot } from "../../src/config/user-config.js";

test("new creation defaults follow XDG and explicit root precedence without shell expansion", () => {
  const home = mkdtempSync(join(tmpdir(), "lucid-config-"));
  try {
    const fallback = join(home, ".config/lucid");
    mkdirSync(fallback, { recursive: true });
    expect(readUserConfig({ home, xdgConfigHome: "relative" }).recordsDir).toBe(
      join(home, ".lucid/records"),
    );
    expect(readUserConfig({ home, xdgConfigHome: "relative" }).defaults).toEqual({
      harness: "claude",
      model: "opus",
      effort: "high",
      profile: "headless-turn",
    });
    writeFileSync(join(fallback, "config.toml"), "version = 1\n");
    expect(readUserConfig({ home, xdgConfigHome: "" }).recordsDir).toBe(
      join(home, ".lucid/records"),
    );
    writeFileSync(
      join(fallback, "config.toml"),
      'version = 1\nrecords_dir = "~/history"\n[defaults]\neffort = "medium"\n',
    );
    const config = readUserConfig({ home, xdgConfigHome: "" });
    expect(config.recordsDir).toBe(join(home, "history"));
    expect(config.defaults.effort).toBe("medium");
    expect(resolveRecordRoot(undefined, config, "/env-root")).toBe("/env-root");
    expect(resolveRecordRoot("/explicit", config, "/env-root")).toBe("/explicit");
    expect(resolveRecordRoot(undefined, config, undefined)).toBe(join(home, "history"));
    const xdg = join(home, "custom/lucid");
    mkdirSync(xdg, { recursive: true });
    writeFileSync(join(xdg, "config.toml"), 'version = 1\nrecords_dir = "/literal/$HOME"\n');
    expect(readUserConfig({ home, xdgConfigHome: join(home, "custom") }).recordsDir).toBe(
      "/literal/$HOME",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid configuration is reported rather than replaced by defaults", () => {
  const home = mkdtempSync(join(tmpdir(), "lucid-config-invalid-"));
  const folder = join(home, ".config/lucid");
  mkdirSync(folder, { recursive: true });
  try {
    for (const content of [
      "broken = =",
      "version = 2",
      "version = 1\nunknown = true",
      'version = 1\nrecords_dir = "relative"',
      'version = 1\n[defaults]\nharness = "other"',
      "version = 1\n[defaults]\nmodel = 42",
      'version = 1\n[defaults]\nprofile = "headless"',
      'version = 1\n[defaults]\nfoo = "bar"',
      'version = 1\ndefaults = "oops"',
      'records_dir = "/tmp"',
    ]) {
      writeFileSync(join(folder, "config.toml"), content);
      expect(() => readUserConfig({ home, xdgConfigHome: "" })).toThrow();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
