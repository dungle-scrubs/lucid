import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, readSettings, resetSettingsCache } from "../src/core/settings.ts";

/**
 * `~/.lucid/settings.json` is a convenience, so every unhappy path resolves to
 * the documented defaults rather than failing anything that reads it.
 */
describe("readSettings", () => {
  const write = async (body: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "lucid-settings-"));
    const file = join(dir, "settings.json");
    await writeFile(file, body, "utf8");
    return file;
  };

  test("yolo defaults ON with no settings file at all", async () => {
    resetSettingsCache();
    expect(DEFAULT_SETTINGS.resumeYolo).toBe(true);
    expect(await readSettings(join(tmpdir(), "lucid-no-such-settings.json"))).toEqual({
      resumeYolo: true,
    });
  });

  test("an explicit false is honoured", async () => {
    expect(await readSettings(await write('{"resumeYolo": false}'))).toEqual({ resumeYolo: false });
  });

  test("a non-boolean value falls back rather than being coerced", async () => {
    // "false" the string is not false, and guessing which way to coerce it is
    // how a settings file starts silently doing the opposite of what it says.
    expect(await readSettings(await write('{"resumeYolo": "false"}'))).toEqual({
      resumeYolo: true,
    });
  });

  test("malformed JSON is not a crash", async () => {
    expect(await readSettings(await write("{not json"))).toEqual(DEFAULT_SETTINGS);
  });

  test("unknown keys are ignored", async () => {
    expect(await readSettings(await write('{"whatIsThis": 1, "resumeYolo": false}'))).toEqual({
      resumeYolo: false,
    });
  });
});
