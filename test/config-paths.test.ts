import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { configFile } from "../src/core/config-paths.ts";

/**
 * M1.8 - one config-path owner. The registry, roots, and settings resolvers
 * each spelled out `explicit ?? $ENV ?? ~/.lucid/<name>` three times, and none
 * honored a `LUCID_HOME` override (so you could not point Lucid's whole config
 * tree elsewhere for a test or a second install). `configFile` owns it once.
 */
describe("M1.8: configFile precedence", () => {
  const env = ["LUCID_HOME", "LUCID_REGISTRY", "LUCID_ROOTS", "LUCID_SETTINGS"];
  const snapshot: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of env) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of env) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  test("default is ~/.lucid/<name>", () => {
    expect(configFile("registry.json", "LUCID_REGISTRY")).toBe(
      join(homedir(), ".lucid", "registry.json"),
    );
  });

  test("an explicit path wins over everything", () => {
    process.env.LUCID_HOME = "/tmp/home";
    process.env.LUCID_REGISTRY = "/tmp/env/reg.json";
    expect(configFile("registry.json", "LUCID_REGISTRY", "/explicit/reg.json")).toBe(
      "/explicit/reg.json",
    );
  });

  test("the per-file env var beats LUCID_HOME and the default", () => {
    process.env.LUCID_HOME = "/tmp/home";
    process.env.LUCID_ROOTS = "/tmp/env/roots.json";
    expect(configFile("roots.json", "LUCID_ROOTS")).toBe("/tmp/env/roots.json");
  });

  test("LUCID_HOME relocates the whole config tree (the new override)", () => {
    process.env.LUCID_HOME = "/tmp/elsewhere";
    expect(configFile("settings.json", "LUCID_SETTINGS")).toBe("/tmp/elsewhere/settings.json");
    expect(configFile("roots.json", "LUCID_ROOTS")).toBe("/tmp/elsewhere/roots.json");
  });
});
