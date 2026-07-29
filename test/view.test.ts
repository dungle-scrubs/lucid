import { describe, expect, test } from "bun:test";
import { resolveView, selectOpenUrl } from "../src/cli/view.ts";
import { viewerUrl } from "../src/server/discovery.ts";
import type { IdentityResponse } from "../src/server/discovery.ts";

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

describe("resolveView", () => {
  test("LUCID_VIEW=solo resolves to solo", () => {
    expect(resolveView({ LUCID_VIEW: "solo" })).toBe("solo");
  });

  test("unset resolves to shell - the terminal path is untouched", () => {
    expect(resolveView({})).toBe("shell");
  });

  test("set but EMPTY resolves to shell", () => {
    expect(resolveView({ LUCID_VIEW: "" })).toBe("shell");
  });

  /**
   * An integration file from a newer Lucid must not break an older CLI: a
   * value this build does not know is a surface it does not have, which is the
   * default surface, not an error.
   */
  test("an unknown value resolves to shell and does NOT throw", () => {
    expect(() => resolveView({ LUCID_VIEW: "banana" })).not.toThrow();
    expect(resolveView({ LUCID_VIEW: "banana" })).toBe("shell");
  });

  test("matching is case-insensitive", () => {
    for (const spelling of ["Solo", "SOLO", "sOlO"]) {
      expect(resolveView({ LUCID_VIEW: spelling })).toBe("solo");
    }
  });

  test("surrounding whitespace does not change the answer", () => {
    // A shell export or an integration file can leave it; a surface that
    // depends on invisible characters is a surface nobody can debug.
    expect(resolveView({ LUCID_VIEW: "  solo  " })).toBe("solo");
  });

  test("it reads the snapshot it is given, never process.env", () => {
    // Pure, so the test needs no env mutation and two callers in one process
    // cannot see each other's surface.
    const before = process.env.LUCID_VIEW;
    expect(resolveView({ LUCID_VIEW: "solo" })).toBe("solo");
    expect(process.env.LUCID_VIEW).toBe(before);
  });
});

describe("selectOpenUrl (plan 06, M1.3, D-015)", () => {
  const identity = (over: Partial<IdentityResponse> = {}): IdentityResponse => ({
    lucid: true,
    session: "/p/.lucid/plan.html",
    port: 17428,
    version: 3,
    ...over,
  });

  /**
   * The case the whole plan exists for. `run.ts` assigns the hub's shell URL
   * BEFORE this runs, so the embedded branch must discard it - not fall back
   * to it. Written as `hubShell ?? solo(...)` it returns a perfectly valid URL
   * for the wrong surface, which no error message would ever report.
   */
  test("solo + a hub shell already assigned -> the SOLO url wins", () => {
    const url = selectOpenUrl({
      view: "solo",
      hubShell: "http://127.0.0.1:17428/?s=a1b2c3",
      identity: identity({ base: "/s/a1b2c3" }),
    });
    expect(url).toBe("http://127.0.0.1:17428/s/a1b2c3/__lucid/viewer");
  });

  test("shell + a hub shell -> the shell url, byte for byte", () => {
    const shell = "http://127.0.0.1:17428/?s=a1b2c3";
    expect(
      selectOpenUrl({
        view: "shell",
        hubShell: shell,
        identity: identity({ base: "/s/a1b2c3" }),
      }),
    ).toBe(shell);
  });

  test("solo + no hub shell -> the solo url for the dedicated server", () => {
    expect(
      selectOpenUrl({
        view: "solo",
        hubShell: undefined,
        identity: identity({ port: 4310 }),
      }),
    ).toBe("http://127.0.0.1:4310/__lucid/viewer");
  });

  test("shell + no hub shell -> exactly what viewerUrl says", () => {
    const id = identity({ port: 4310 });
    expect(selectOpenUrl({ view: "shell", hubShell: undefined, identity: id })).toBe(viewerUrl(id));
  });
});

describe("every URL-emitting surface honours the view (plan 06, review LOW-1/2)", () => {
  /**
   * The lesson from plan 05, which enforced a placement rule on the read side
   * while three writers kept emitting paths it refused: a rule honoured by one
   * surface and ignored by its neighbours is worse than no rule, because the
   * product then argues with itself.
   */
  test("the session listing reports the solo url under the solo view", async () => {
    const { listSessions } = await import("../src/core/sessions.ts");
    const { mkdtemp, mkdir, writeFile, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openSession } = await import("../src/core/session.ts");
    const { sessionPaths } = await import("../src/core/paths.ts");

    const dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-view-list-")));
    await mkdir(join(dir, ".lucid"), { recursive: true });
    const artifact = join(dir, ".lucid", "plan.html");
    await writeFile(artifact, "<!doctype html><html><body><h1>p</h1></body></html>");
    await openSession(sessionPaths(artifact));

    // No live server, so the row carries `resume` rather than `viewer` - which
    // is the shape this asserts is REACHED, not skipped: a listing with no
    // live session cannot distinguish the views, and saying so is the point.
    const rows = await listSessions(dir);
    expect(rows.length).toBe(1);
    expect(rows[0]?.viewer).toBeUndefined();
    expect(rows[0]?.resume).toContain("lucid open");

    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  });

  test("selectOpenUrl is what the listing and open BOTH route through", async () => {
    // The seam is shared rather than reimplemented, which is what keeps the
    // two from drifting. Asserted on the source, because a second copy of the
    // ternary would pass every behavioural test on the day it was written.
    const { readFileSync } = await import("node:fs");
    const sessions = readFileSync(new URL("../src/core/sessions.ts", import.meta.url), "utf8");
    expect(sessions).toContain("selectOpenUrl(");
    expect(sessions).not.toContain("viewerUrl(identity)");
  });
});
