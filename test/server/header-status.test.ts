import { describe, expect, test } from "bun:test";
import { connectionSummary } from "../../src/server/client/header-connection.js";
import { documentThemeNote } from "../../src/server/client/theme-controls.js";

describe("the theme toggle's document note", () => {
  test("adaptive documents and pages without one need no note", () => {
    expect(documentThemeNote("adaptive", "dark", false)).toBeNull();
    expect(documentThemeNote(null, "light", true)).toBeNull();
  });

  test("a fixed theme is explained, and flagged only while it differs", () => {
    const differs = documentThemeNote("dark", "light", false);
    expect(differs?.help).toContain("fixed dark theme");
    expect(differs?.mismatch).toBe("Page is dark only");
    expect(documentThemeNote("dark", "dark", false)?.mismatch).toBeNull();
    expect(documentThemeNote("light", "dark", true)?.mismatch).toBe("Page is light only");
  });

  test("an unmanaged document follows the system, not Lucid", () => {
    const differs = documentThemeNote("unmanaged", "dark", false);
    expect(differs?.help).toContain("follows your system setting");
    expect(differs?.mismatch).toBe("Page follows system (light)");
    expect(documentThemeNote("unmanaged", "dark", true)?.mismatch).toBeNull();
  });
});

describe("the header connection label", () => {
  test("states that need the reader's attention read as a warning", () => {
    expect(connectionSummary("setup-required")).toEqual(["Not connected", "warn"]);
    expect(connectionSummary("resume-failed")).toEqual(["Connection needs attention", "warn"]);
  });

  test("working and healthy states read as such", () => {
    expect(connectionSummary("listening")).toEqual(["Session connected", "ok"]);
    expect(connectionSummary("headless-running")).toEqual(["Agent replying", "busy"]);
  });
});
