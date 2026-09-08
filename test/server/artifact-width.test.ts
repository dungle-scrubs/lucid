import { describe, expect, test } from "bun:test";
import {
  artifactWidthKey,
  artifactWidthPixels,
  parseArtifactWidth,
  preferredArtifactWidth,
  readArtifactWidth,
  writeArtifactWidth,
} from "../../src/server/client/artifact-width.js";

describe("authored frame width", () => {
  test("accepts bounded numeric units and full width", () => {
    expect(parseArtifactWidth(" 72rem ")).toEqual({ unit: "rem", value: 72 });
    expect(parseArtifactWidth("900px")).toEqual({ unit: "px", value: 900 });
    expect(parseArtifactWidth("80.5%")).toEqual({ unit: "%", value: 80.5 });
    expect(parseArtifactWidth("full")).toEqual({ unit: "full" });
  });
  test("rejects unbounded, nonnumeric, executable, and unsupported CSS", () => {
    for (const input of [
      null,
      "",
      "0px",
      "-40px",
      "101%",
      "10001px",
      "626rem",
      "NaNpx",
      "Infinityrem",
      "1e2px",
      "52vw",
      "var(--width)",
      "calc(100% - 20px)",
      "50%;color:red",
      "80PX",
    ])
      expect(parseArtifactWidth(input)).toEqual({ unit: "full" });
  });
  test("reads the first head declaration rather than strings, comments or body metadata", () => {
    expect(
      preferredArtifactWidth(
        `<!doctype html><head><!-- <meta name="lucid-width" content="10px"> --><script>const x='<meta name="lucid-width" content="20px">';</script><META NAME="lucid-width" CONTENT="72rem"><meta name="lucid-width" content="80%"></head><body><meta name="lucid-width" content="30px"></body>`,
      ),
    ).toEqual({ unit: "rem", value: 72 });
    expect(
      preferredArtifactWidth(
        `<head><meta name="lucid-width" content="invalid"><meta name="lucid-width" content="72rem"></head>`,
      ),
    ).toEqual({ unit: "full" });
    expect(
      preferredArtifactWidth(`<body><meta name="lucid-width" content="72rem"></body>`),
    ).toEqual({ unit: "full" });
  });
  test("reader overrides the author while both stay within the available pane", () => {
    const authored = parseArtifactWidth("72rem");
    expect(artifactWidthPixels(authored, null, 1400, 16)).toBe(1152);
    expect(artifactWidthPixels(authored, 50, 1400, 16)).toBe(700);
    expect(artifactWidthPixels(authored, null, 800, 16)).toBe(800);
    expect(artifactWidthPixels(parseArtifactWidth("80%"), null, 1000, 16)).toBe(800);
    expect(artifactWidthPixels(parseArtifactWidth("72rem"), null, 2000, 20)).toBe(1440);
  });
  test("the frame floor wins when space permits, without overflowing narrow panes", () => {
    expect(artifactWidthPixels(parseArtifactWidth("1px"), null, 400, 16)).toBe(320);
    expect(artifactWidthPixels(parseArtifactWidth("full"), 25, 400, 16)).toBe(320);
    expect(artifactWidthPixels(parseArtifactWidth("full"), 25, 250, 16)).toBe(250);
    expect(artifactWidthPixels(parseArtifactWidth("full"), null, 0, 16)).toBe(0);
  });
});

describe("reader width preference", () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    removeItem: (key: string): void => {
      values.delete(key);
    },
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
  test("persists and resets each exact identity independently", () => {
    const first = artifactWidthKey("a:b", "c");
    const second = artifactWidthKey("a", "b:c");
    expect(first).not.toBe(second);
    writeArtifactWidth(store, first, 60);
    writeArtifactWidth(store, second, 80);
    expect(readArtifactWidth(store, first)).toBe(60);
    expect(readArtifactWidth(store, second)).toBe(80);
    writeArtifactWidth(store, first, null);
    expect(readArtifactWidth(store, first)).toBeNull();
    expect(readArtifactWidth(store, second)).toBe(80);
  });
  test("ignores malformed storage and remains usable when storage throws", () => {
    for (const value of ["0", "101", "50junk", "50.5", "NaN"]) {
      store.setItem("bad", value);
      expect(readArtifactWidth(store, "bad")).toBeNull();
    }
    const denied = {
      getItem: (): never => {
        throw new Error("unavailable");
      },
      removeItem: (): never => {
        throw new Error("unavailable");
      },
      setItem: (): never => {
        throw new Error("quota");
      },
    };
    expect(readArtifactWidth(denied, "key")).toBeNull();
    expect(() => writeArtifactWidth(denied, "key", 60)).not.toThrow();
    expect(() => writeArtifactWidth(denied, "key", null)).not.toThrow();
  });
});
