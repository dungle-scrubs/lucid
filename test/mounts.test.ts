import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactPath, sessionPaths } from "../src/core/paths.ts";
import { createMounts } from "../src/server/mounts.ts";

/**
 * M0.1 - the Mounts module is the single owner of the hosted-session map.
 *
 * The routability-ordering invariant: a mount is visible to routing
 * (`has`/`get`) ONLY after its descriptor write succeeds. If the write rolls
 * back, no half-built mount is left behind for a concurrent route to reach.
 */
describe("M0.1: createMounts routability ordering", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-mounts-")));
  });
  afterEach(async () => {
    // Restore writability so the temp dir can be removed.
    try {
      await chmod(join(dir, "locked"), 0o700).catch(() => {});
    } catch {
      // dir may already be gone
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("a descriptor-write failure leaves no mount visible to routing", async () => {
    // A valid session the host can construct against: artifact, log, and a
    // real run/ with a current.html.
    const artifact = canonicalArtifactPath(join(dir, "proj", "notes.html"));
    const paths = sessionPaths(artifact);
    await mkdir(paths.runDir, { recursive: true });
    await writeFile(
      paths.logPath,
      `${JSON.stringify({
        seq: 1,
        at: "2026-01-01T00:00:00.000Z",
        t: "session_opened",
        segment: 1,
        version: 1,
        artifact: "notes.html",
        hash: "h",
        path: "versions/s1/v1.html",
      })}\n`,
    );
    await writeFile(paths.currentHtml, "<h1 data-lucid-id='t'>Notes</h1>");

    // A directory the descriptor write cannot land in (read+execute, no write).
    // Only serverJson points here; the host's own paths stay valid, so the
    // failure isolates to writeServerDescriptor - exactly the rollback path.
    const locked = join(dir, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o500);

    const mounts = createMounts({
      log: () => {},
      port: () => 0,
      stopped: () => false,
      sessionPaths: () => ({ ...paths, serverJson: join(locked, "server.json") }),
      upgrade: () => false,
      sessionIdleMs: 60_000,
      attend: false,
      attendPollMs: 60_000,
    });

    // The mount must reject: the descriptor write failed. The assertion that
    // matters is the one after - the failed mount is not routable.
    await expect(mounts.mount("id-1", artifact)).rejects.toThrow();
    expect(mounts.has("id-1")).toBe(false);
    expect(mounts.get("id-1")).toBeUndefined();
  });
});
