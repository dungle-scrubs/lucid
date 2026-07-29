import { describe, expect, test } from "bun:test";
import { resolveSurface } from "../src/cli/surface.ts";

/**
 * Which SURFACE an open is for (plan 06, M1.1).
 *
 * Inside a chat desktop app the embedded browser pane must show one
 * session's artifact with the full review UI, never the hub shell - the chat
 * app already plays the role the shell plays for a terminal harness. The
 * channel is an explicit opt-in env var, never app-sniffing: those apps' own
 * env vars are undocumented and unstable, while this one rides the same
 * per-harness integration file that already delivers LUCID_HARNESS and
 * reaches the session log intact.
 */

describe("resolveSurface", () => {
  test("LUCID_SURFACE=embedded resolves to embedded", () => {
    expect(resolveSurface({ LUCID_SURFACE: "embedded" })).toBe("embedded");
  });

  test("unset resolves to default - the terminal path is untouched", () => {
    expect(resolveSurface({})).toBe("default");
  });

  test("set but EMPTY resolves to default", () => {
    expect(resolveSurface({ LUCID_SURFACE: "" })).toBe("default");
  });

  /**
   * An integration file from a newer Lucid must not break an older CLI: a
   * value this build does not know is a surface it does not have, which is the
   * default surface, not an error.
   */
  test("an unknown value resolves to default and does NOT throw", () => {
    expect(() => resolveSurface({ LUCID_SURFACE: "banana" })).not.toThrow();
    expect(resolveSurface({ LUCID_SURFACE: "banana" })).toBe("default");
  });

  test("matching is case-insensitive", () => {
    for (const spelling of ["Embedded", "EMBEDDED", "eMbEdDeD"]) {
      expect(resolveSurface({ LUCID_SURFACE: spelling })).toBe("embedded");
    }
  });

  test("surrounding whitespace does not change the answer", () => {
    // A shell export or an integration file can leave it; a surface that
    // depends on invisible characters is a surface nobody can debug.
    expect(resolveSurface({ LUCID_SURFACE: "  embedded  " })).toBe("embedded");
  });

  test("it reads the snapshot it is given, never process.env", () => {
    // Pure, so the test needs no env mutation and two callers in one process
    // cannot see each other's surface.
    const before = process.env.LUCID_SURFACE;
    expect(resolveSurface({ LUCID_SURFACE: "embedded" })).toBe("embedded");
    expect(process.env.LUCID_SURFACE).toBe(before);
  });
});
