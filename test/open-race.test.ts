import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { ensureSessionDirs, openSession } from "../src/core/session.ts";
import { ensureServer } from "../src/cli/self.ts";
import { writeServerDescriptor } from "../src/server/discovery.ts";

/**
 * Two agents opening the same artifact at the same instant must end up with ONE
 * server (plan 08, finding #16).
 *
 * `open` read the descriptor, found nothing, and spawned - so two processes
 * that both read before either wrote both spawned. Two servers for one artifact
 * is not merely a duplicate: each is an appender on the same log, which is the
 * thing the append lock exists to prevent, and the loser's descriptor overwrites
 * the winner's so the two callers can disagree about the URL they just opened.
 *
 * The e2e that catches this (test/e2e/concurrent.e2e.ts) only reproduces under
 * full-suite load - measured 0/20 in isolation against 2/20 in a full run - so
 * the race is pinned here, where it is deterministic.
 */

let dir: string;
let paths: SessionPaths;
let stubs: Array<ReturnType<typeof Bun.serve>>;

const DOC = '<!doctype html><html><body><h1 data-lucid-id="h">Hello</h1></body></html>';

/**
 * Stand-in for `spawnServer`: starts a server that answers the handshake and
 * publishes its descriptor, exactly as `__serve` does, but in-process so the
 * test can count how many were started.
 */
const startStub = async (): Promise<void> => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname === "/__lucid/identity") {
        return Response.json({
          lucid: true,
          session: paths.artifactPath,
          port: server.port,
          version: 1,
        });
      }
      return Response.json({ ok: true });
    },
  });
  stubs.push(server);
  const port = server.port;
  if (port === undefined) throw new Error("stub did not bind");
  await writeServerDescriptor(paths, {
    port,
    pid: process.pid,
    session: paths.artifactPath,
    startedAt: new Date().toISOString(),
  });
};

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-open-race-")));
  paths = sessionPaths(join(dir, "plan.html"));
  await writeFile(paths.artifactPath, DOC);
  ensureSessionDirs(paths);
  stubs = [];
});

afterEach(async () => {
  for (const s of stubs) s.stop(true);
  await rm(dir, { recursive: true, force: true });
});

describe("two simultaneous opens start one server (finding #16)", () => {
  test("the second caller waits for the first rather than spawning its own", async () => {
    let spawned = 0;
    const spawn = (): void => {
      spawned++;
      // Deliberately not awaited: the real `spawnServer` returns immediately
      // and the server comes up afterwards, which is the window the race lives
      // in. A stub that published its descriptor synchronously would close that
      // window and the test would pass against the unfixed code.
      void startStub();
    };

    const [a, b] = await Promise.all([
      ensureServer(paths, { spawn, waitMs: 4000 }),
      ensureServer(paths, { spawn, waitMs: 4000 }),
    ]);

    expect(spawned).toBe(1);
    expect(a?.port).toBeDefined();
    // Both callers must name the same server. Disagreeing here is what the e2e
    // sees: two URLs for one artifact.
    expect(a?.port).toBe(b?.port);
    expect(stubs.length).toBe(1);
  });

  test("a caller that finds a live server never spawns at all", async () => {
    await startStub();
    let spawned = 0;

    const found = await ensureServer(paths, {
      spawn: () => {
        spawned++;
      },
      waitMs: 2000,
    });

    expect(spawned).toBe(0);
    expect(found?.port).toBe(stubs[0]?.port);
  });

  test("ten racing callers still start exactly one", async () => {
    let spawned = 0;
    const spawn = (): void => {
      spawned++;
      void startStub();
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ensureServer(paths, { spawn, waitMs: 4000 })),
    );

    expect(spawned).toBe(1);
    const ports = new Set(results.map((r) => r?.port));
    expect(ports.size).toBe(1);
  });
});

/**
 * The other half of the same race: serializing who may START a server says
 * nothing about who may OPEN the session, and `open` does both. Two callers
 * that read an unopened log before either appended both wrote
 * `session_opened`, and a second one restarts the segment - so anything the
 * first opener's server had already committed dropped out of the fold.
 */
describe("two simultaneous opens open the session once", () => {
  test("the second opener finds the segment already open", async () => {
    const [a, b] = await Promise.all([openSession(paths), openSession(paths)]);

    const { events } = await readEvents(paths.logPath);
    expect(events.filter((e) => e.t === "session_opened")).toHaveLength(1);
    // Exactly one caller may claim it started the segment; the other resumed
    // what was already there.
    expect([a.startedSegment, b.startedSegment].filter(Boolean)).toHaveLength(1);
    // Both still see the open session they asked for.
    expect(a.state.status).toBe("active");
    expect(b.state.status).toBe("active");
  });

  test("ten racing opens still append one session_opened", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => openSession(paths)));

    const { events } = await readEvents(paths.logPath);
    expect(events.filter((e) => e.t === "session_opened")).toHaveLength(1);
    expect(results.filter((r) => r.startedSegment)).toHaveLength(1);
  });
});
