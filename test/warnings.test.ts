import { describe, expect, test } from "bun:test";
import { warningText } from "../client/chrome/warnings.ts";

/**
 * The viewer owns the WORDS; the server owns the CODE. These tests pin the
 * half that decides what a human reads when delivery stops - and that no
 * harness content can reach them through it.
 */
describe("identity failures say what happened to the feedback", () => {
  test("an unavailable session names the cause and where the feedback stands", () => {
    const text = warningText("HARNESS_SESSION_UNAVAILABLE", "");
    expect(text).toContain("no longer exists on this machine");
    // The point a human needs: their words were not lost.
    expect(text).toContain("stays recorded");
  });

  test("a mismatch says the feedback was NOT sent, not merely that a turn failed", () => {
    const text = warningText("HARNESS_SESSION_MISMATCH", "");
    expect(text).toContain("different conversation");
    expect(text).toContain("not sent");
    expect(text).toContain("still recorded");
  });

  test("the wording ignores the payload entirely, so no harness output can ride in", () => {
    // The server sends a message alongside the code; for a closed identity
    // code the viewer's own sentence wins, whatever arrives.
    const smuggled = "Error: ANTHROPIC_API_KEY=sk-secret leaked from the harness";
    for (const code of ["HARNESS_SESSION_UNAVAILABLE", "HARNESS_SESSION_MISMATCH"]) {
      expect(warningText(code, smuggled)).not.toContain("sk-secret");
    }
  });

  test("codes the viewer has no wording for still show the server's prose", () => {
    expect(warningText("ASSET_NOT_FOUND", "asset not found: /x.png")).toBe(
      "asset not found: /x.png",
    );
  });
});
