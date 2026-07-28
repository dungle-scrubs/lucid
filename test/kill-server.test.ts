import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPaths } from "../src/core/paths.ts";
import { killSessionServer } from "./e2e/kill-server.ts";

/** A session whose `server.json` says a server is listening, whether or not one
 *  actually is. Port 1 is never bound, so the handshake cannot succeed. */
const sessionWithDescriptor = async (
  port: number,
  pid: number,
): Promise<{ artifact: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-kill-test-"));
  const artifact = join(dir, "plan.html");
  await writeFile(artifact, "<!doctype html><title>t</title><h1>t</h1>");
  const paths = sessionPaths(artifact);
  await mkdir(paths.runDir, { recursive: true });
  await writeFile(
    paths.serverJson,
    JSON.stringify({ port, pid, session: artifact, startedAt: new Date(0).toISOString() }),
  );
  return { artifact, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

describe("killSessionServer", () => {
  test("REFUSES to signal a pid when the session does not answer", async () => {
    // The safety property, and the reason this is not three lines. server.json
    // outlives the process that wrote it, and pids are recycled - so firing on
    // a recorded pid without checking means a stale descriptor turns into a
    // SIGKILL aimed at whatever unrelated process inherited that number. The
    // product refuses to infer liveness from a pid for a milder version of this
    // hazard (a blocked `wait`); the harness holds a loaded gun.
    const session = await sessionWithDescriptor(1, process.pid);
    try {
      let signalled: number | undefined;
      await expect(
        killSessionServer(session.artifact, {
          kill: (pid) => {
            signalled = pid;
          },
        }),
      ).rejects.toThrow(/refusing to kill pid/);
      // Not "it threw" - it must not have signalled ANYTHING first.
      expect(signalled).toBeUndefined();
    } finally {
      await session.cleanup();
    }
  });

  test("the refusal says the descriptor is stale, not that the kill failed", async () => {
    const session = await sessionWithDescriptor(1, 999_999);
    try {
      await expect(killSessionServer(session.artifact, { kill: () => {} })).rejects.toThrow(
        /stale/,
      );
    } finally {
      await session.cleanup();
    }
  });

  test("a session that was never opened is a clear error, not a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucid-kill-test-"));
    try {
      await expect(killSessionServer(join(dir, "never-opened.html"))).rejects.toThrow(
        /nothing to kill/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
