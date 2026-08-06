import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverToLive } from "../src/core/deliver.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { REQUEST_ID_HEADER } from "../src/core/request-id.ts";
import { writeServerDescriptor } from "../src/server/discovery.ts";

/**
 * M1.4 (D-005) - the one live-delivery seam. Every CLI write that can reach a
 * live server goes through `deliverToLive`: discover, POST, and report which of
 * the three outcomes happened. The caller decides the policy by pattern-
 * matching the result - `ignore` (deliver: throw on live-failure), `fallback-
 * Offline` (runContext: sidecar on offline OR live-failure, never a log
 * append), `keepOwed` (promotePendingBindings: keep owed on live-failure).
 *
 * The contract here is the dispatch itself; the three policies are pinned at
 * their callers.
 */
describe("M1.4: deliverToLive - one discover+POST seam", () => {
  let dir: string;
  let paths: SessionPaths;
  let stub: ReturnType<typeof Bun.serve> | undefined;
  let received: { path: string; body: unknown } | undefined;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-deliver-")));
    const artifact = join(dir, "plan.html");
    paths = sessionPaths(artifact);
    await mkdir(paths.runDir, { recursive: true });
    received = undefined;
  });
  afterEach(async () => {
    stub?.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  /** A live server that answers the handshake and records the POST. */
  const startLive = async (respond: (path: string) => Response): Promise<void> => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req): Promise<Response> {
        const { pathname } = new URL(req.url);
        if (pathname === "/__lucid/identity") {
          return Response.json({
            lucid: true,
            session: paths.artifactPath,
            port: server.port,
            version: 1,
          });
        }
        received = { path: pathname, body: await req.json().catch(() => null) };
        return respond(pathname);
      },
    });
    stub = server;
    const port = server.port;
    if (port === undefined) throw new Error("stub server did not bind");
    await writeServerDescriptor(paths, {
      port,
      pid: process.pid,
      session: paths.artifactPath,
      startedAt: new Date().toISOString(),
    });
  };

  test("a live server that accepts the POST reports live: true", async () => {
    await startLive(() => Response.json({ ok: true }));
    const outcome = await deliverToLive(paths, "/__lucid/reply", { hello: "world" });
    expect(outcome).toEqual({ live: true });
    expect(received?.path).toBe("/__lucid/reply");
    expect(received?.body).toEqual({ hello: "world" });
  });

  test("no live server is the offline outcome (not a failure)", async () => {
    // No descriptor written: discoverLiveServer finds nothing.
    const outcome = await deliverToLive(paths, "/__lucid/reply", { x: 1 });
    expect(outcome.live).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("offline");
  });

  test("a live server that refuses (non-ok) is a live-failure outcome", async () => {
    await startLive(() => new Response("no", { status: 500 }));
    const outcome = await deliverToLive(paths, "/__lucid/reply", { x: 1 });
    expect(outcome.live).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("live-failure");
    expect((outcome as { error: unknown }).error).toBeDefined();
  });

  test("a live delivery carries the turn's trace header (observability, D-005)", async () => {
    // The trace joins a turn's write to the click that caused it; loopbackFetch
    // stamps it, so the seam must not strip it. Every policy rides the same
    // POST, so one assertion covers all three.
    const prev = process.env.LUCID_REQUEST_ID;
    process.env.LUCID_REQUEST_ID = "0123456789abcdef";
    let seenTrace: string | undefined;
    try {
      await startLive(() => Response.json({ ok: true }));
      // Re-point the stub at a handler that captures the header on the POST.
      stub?.stop(true);
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req): Response {
          const { pathname } = new URL(req.url);
          if (pathname === "/__lucid/identity") {
            return Response.json({
              lucid: true,
              session: paths.artifactPath,
              port: server.port,
              version: 1,
            });
          }
          seenTrace = req.headers.get(REQUEST_ID_HEADER) ?? undefined;
          return Response.json({ ok: true });
        },
      });
      stub = server;
      const port = server.port;
      if (port === undefined) throw new Error("stub server did not bind");
      await writeServerDescriptor(paths, {
        port,
        pid: process.pid,
        session: paths.artifactPath,
        startedAt: new Date().toISOString(),
      });
      const outcome = await deliverToLive(paths, "/__lucid/reply", { x: 1 });
      expect(outcome).toEqual({ live: true });
      expect(seenTrace).toBe("0123456789abcdef");
    } finally {
      if (prev === undefined) delete process.env.LUCID_REQUEST_ID;
      else process.env.LUCID_REQUEST_ID = prev;
    }
  });
});
