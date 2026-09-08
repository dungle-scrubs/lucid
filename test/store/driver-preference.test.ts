/**
 * The driver preference file (RFC-12).
 *
 * `driver.json`, beside `meta.json`. What carries the weight here: the file
 * is a standing choice rewritten at will, so it is never appended to the
 * log; the write is an atomic replace, so a driver reading while the server
 * replaces it gets the whole old file or the whole new one; and the read is
 * tolerant, because a sidecar that cannot be read must not cost a
 * conversation.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDriverField,
  isDriverHarness,
  preferenceState,
  readDriverPreference,
  requireDriverPreference,
  writeDriverPreference,
} from "../../src/store/driver-preference.js";
import { createConversationRecord } from "../../src/store/store.js";

const rec = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lucid-driver-"));
  createConversationRecord(root, "c");
  return join(root, "c");
};

describe("a round trip", () => {
  test("what is written is what is read back", () => {
    const dir = rec();
    writeDriverPreference(dir, { harness: "pi", model: "qwen3.6-35b-a3b-mlx", effort: "high" });
    expect(readDriverPreference(dir)).toEqual({
      v: 1,
      harness: "pi",
      model: "qwen3.6-35b-a3b-mlx",
      effort: "high",
    });
  });

  test("the file carries the version stamp, like meta.json", () => {
    const dir = rec();
    writeDriverPreference(dir, { harness: "claude" });
    const file = JSON.parse(readFileSync(join(dir, "driver.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(file.v).toBe(1);
    expect(file.harness).toBe("claude");
  });

  test("a field left out is a field cleared, not a field kept", () => {
    const dir = rec();
    writeDriverPreference(dir, { harness: "codex", model: "o4", effort: "low" });
    writeDriverPreference(dir, { harness: "codex" });
    expect(readDriverPreference(dir)).toEqual({ v: 1, harness: "codex" });
    const file = readFileSync(join(dir, "driver.json"), "utf8");
    expect(file).not.toContain("model");
    expect(file).not.toContain("effort");
  });
});

describe("the file-write discipline", () => {
  test("0o600, like every file in the record", () => {
    const dir = rec();
    writeDriverPreference(dir, { harness: "muse" });
    expect(statSync(join(dir, "driver.json")).mode & 0o777).toBe(0o600);
  });

  test("replaces atomically: no temporary is left behind", () => {
    const dir = rec();
    writeDriverPreference(dir, { harness: "claude" });
    writeDriverPreference(dir, { harness: "claude", model: "opus" });
    expect(readdirSync(dir).some((name) => name.includes(".part"))).toBe(false);
  });

  test("never touches the log", () => {
    const dir = rec();
    const logBefore = readFileSync(join(dir, "log.ndjson"), "utf8");
    writeDriverPreference(dir, { harness: "pi", provider: "lmstudio" });
    expect(readFileSync(join(dir, "log.ndjson"), "utf8")).toBe(logBefore);
  });
});

describe("reading when there is nothing to read", () => {
  test("no file is no preference, not an error", () => {
    const dir = rec();
    expect(readDriverPreference(dir)).toBeNull();
  });

  test("a record that does not exist yet reads the same way", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-driver-empty-"));
    expect(readDriverPreference(join(root, "never-made"))).toBeNull();
  });
});

describe("the tolerant read", () => {
  test("unknown fields are ignored, not fatal", () => {
    const dir = rec();
    writeDriverPreference(dir, { harness: "pi", model: "zai/glm-5.2" });
    const file = JSON.parse(readFileSync(join(dir, "driver.json"), "utf8")) as Record<
      string,
      unknown
    >;
    // A later field a reader does not know, in the shape a later version
    // would write it.
    file.sandbox = "workspace-write";
    writeFileSync(join(dir, "driver.json"), JSON.stringify(file));
    expect(readDriverPreference(dir)).toEqual({ v: 1, harness: "pi", model: "zai/glm-5.2" });
  });

  test("a file that does not parse reads as no preference", () => {
    const dir = rec();
    writeFileSync(join(dir, "driver.json"), "{ not json");
    expect(readDriverPreference(dir)).toBeNull();
  });

  test("a harness that is not one of the four is no preference at all", () => {
    const dir = rec();
    writeFileSync(
      join(dir, "driver.json"),
      JSON.stringify({ v: 1, harness: "claude-code", model: "opus" }),
    );
    expect(readDriverPreference(dir)).toBeNull();
  });

  test("malformed known fields remain visible and block execution", () => {
    const dir = rec();
    writeFileSync(
      join(dir, "driver.json"),
      JSON.stringify({ v: 1, harness: "pi", model: "x".repeat(129), effort: 5 }),
    );
    expect(readDriverPreference(dir)).toBeNull();
    expect(preferenceState(dir).error).toContain("malformed");
    expect(() => requireDriverPreference(dir)).toThrow("malformed");
  });
});

describe("the write guard", () => {
  test("a harness that is not one of the four is refused, and nothing is written", () => {
    const dir = rec();
    expect(() => writeDriverPreference(dir, { harness: "sonnet" as "claude" })).toThrow(
      /malformed driver harness/,
    );
    expect(existsSync(join(dir, "driver.json"))).toBe(false);
  });

  test("a field outside the wire-id shape is refused", () => {
    const dir = rec();
    expect(() => writeDriverPreference(dir, { harness: "pi", model: "bad\nmodel" })).toThrow(
      /malformed driver model/,
    );
  });
});

describe("the shape rules, stated once here", () => {
  test("the four names, and only them", () => {
    for (const name of ["claude", "codex", "pi", "muse"]) expect(isDriverHarness(name)).toBe(true);
    for (const bad of ["claude-code", "opencode", "", undefined, null, 3])
      expect(isDriverHarness(bad)).toBe(false);
  });

  test("a field is the wire-id shape: non-empty, bounded, no control characters", () => {
    expect(isDriverField("opus-4.6")).toBe(true);
    expect(isDriverField("x".repeat(128))).toBe(true);
    expect(isDriverField("")).toBe(false);
    expect(isDriverField("x".repeat(129))).toBe(false);
    expect(isDriverField("a\tb")).toBe(false);
    expect(isDriverField(5)).toBe(false);
  });
});
