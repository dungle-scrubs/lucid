import { describe, expect, test } from "bun:test";
import { soloViewerUrl, viewerUrl } from "../src/server/discovery.ts";
import type { IdentityResponse } from "../src/server/discovery.ts";

/**
 * The shell-free review URL (plan 06, M1.2).
 *
 * No new route is built: `/__lucid/viewer` already serves the review UI, and
 * the daemon routes `/s/<id>/*` into the same host body, so a hub-hosted
 * session ALREADY has one. The work is selecting it.
 */

const identity = (over: Partial<IdentityResponse> = {}): IdentityResponse => ({
  lucid: true,
  session: "/p/.lucid/plan.html",
  port: 17428,
  version: 3,
  ...over,
});

describe("soloViewerUrl", () => {
  test("a dedicated identity has no base and serves the viewer at the root", () => {
    expect(soloViewerUrl(identity({ port: 4310 }))).toBe("http://127.0.0.1:4310/__lucid/viewer");
  });

  test("a hub-hosted identity keeps its mount prefix", () => {
    expect(soloViewerUrl(identity({ base: "/s/a1b2c3" }))).toBe(
      "http://127.0.0.1:17428/s/a1b2c3/__lucid/viewer",
    );
  });

  /**
   * The anti-regression that matters: the terminal path is untouched. A change
   * here would move every terminal `open` off the shell.
   */
  test("viewerUrl still returns the SHELL url for the same hub-hosted identity", () => {
    const hosted = identity({ base: "/s/a1b2c3" });
    expect(viewerUrl(hosted)).toBe("http://127.0.0.1:17428/?s=a1b2c3");
    expect(soloViewerUrl(hosted)).not.toBe(viewerUrl(hosted));
  });

  test("viewerUrl and soloViewerUrl agree when there is no shell to differ about", () => {
    // A dedicated server has no shell, so the two views want the same page.
    const dedicated = identity({ port: 4310 });
    expect(soloViewerUrl(dedicated)).toBe(viewerUrl(dedicated));
  });

  /**
   * A base that is not a mount is not string-concatenated into the URL. The
   * same guard shape `viewerUrl` already uses: an unrecognised base means the
   * server did not mount this session, so there is no prefix to carry.
   */
  test("a base that does not match the mount shape is treated as no base", () => {
    for (const base of ["", "/s/NOTHEX", "/x/a1b2", "/s/a1b2/extra", "../etc"]) {
      expect(soloViewerUrl(identity({ base }))).toBe("http://127.0.0.1:17428/__lucid/viewer");
    }
  });
});
