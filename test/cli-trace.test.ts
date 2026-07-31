import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContext } from "../src/cli/run.ts";
import { deliver } from "../src/core/deliver.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { REQUEST_ID_HEADER } from "../src/core/request-id.ts";
import { ensureSessionDirs, openSession } from "../src/core/session.ts";
import { runWait } from "../src/core/wait.ts";
import { hubOpen, runDaemon } from "../src/server/daemon.ts";
import { writeServerDescriptor } from "../src/server/discovery.ts";

/**
 * The CLI's WRITE path carries a trace (plan 07 finding #9). `hubOpen` already
 * stamps `x-lucid-request` on its hub calls; deliver, wait and context did not,
 * so a turn's own writes emitted hub records no grep could join back to the
 * click that spawned the turn. These assert the header on the WIRE - the one
 * place a missing call site shows up - rather than on the source.
 */

/** The click's trace, as a spawned turn inherits it via LUCID_REQUEST_ID. */
const CLICK = "0123456789abcdef";

/** Review content, distinctive enough that a record quoting it is unmissable. */
const SECRET = "the-note-body-that-must-never-be-logged";

let dir: string;
let paths: SessionPaths;
let stub: ReturnType<typeof Bun.serve> | undefined;
let seen: Array<{ path: string; trace: string | null }>;
let previousTrace: string | undefined;

const DOC = '<!doctype html><html><body><h1 data-lucid-id="h">Hello</h1></body></html>';

/**
 * A server that answers the handshake for THIS session and records the trace on
 * every request. Standing in for the real server keeps the assertion on what
 * the CLI sends, not on what a route does with it.
 */
const startStub = async (): Promise<void> => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, trace: req.headers.get(REQUEST_ID_HEADER) });
      if (url.pathname === "/__lucid/identity") {
        return Response.json({
          lucid: true,
          session: paths.artifactPath,
          port: Number(url.port),
          version: 1,
        });
      }
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
};

/** The trace on the first request to `path`, or null when it carried none. */
const traceFor = (path: string): string | null | undefined =>
  seen.find((r) => r.path === path)?.trace;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-trace-")));
  paths = sessionPaths(join(dir, "plan.html"));
  await writeFile(paths.artifactPath, DOC);
  ensureSessionDirs(paths);
  seen = [];
  previousTrace = process.env.LUCID_REQUEST_ID;
  process.env.LUCID_REQUEST_ID = CLICK;
});

afterEach(async () => {
  if (previousTrace === undefined) delete process.env.LUCID_REQUEST_ID;
  else process.env.LUCID_REQUEST_ID = previousTrace;
  stub?.stop(true);
  stub = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("the CLI's write path carries a trace (M9)", () => {
  test("deliver stamps the turn's trace on the event it posts", async () => {
    await startStub();

    await deliver(paths, { t: "agent_reply", id: "r1", text: "the reply body" });

    expect(traceFor("/__lucid/reply")).toBe(CLICK);
  });

  test("wait stamps the turn's trace when it subscribes to the wake stream", async () => {
    await openSession(paths);
    await startStub();

    // A cursor at the open event: no delta, so `wait` subscribes and then rides
    // the window out - which is the state the stream request is made in.
    await runWait(paths, { since: "evt_00001", timeoutMs: 250, pollMs: 40 });

    expect(traceFor("/__lucid/events")).toBe(CLICK);
  });

  test("context stamps the turn's trace on the usage it posts", async () => {
    await startStub();

    await runContext(paths.artifactPath, { pct: 42 });

    expect(traceFor("/__lucid/context")).toBe(CLICK);
  });
});

describe("one trace joins a turn's write to the click that caused it (M9)", () => {
  test("the hub's open record and the turn's reply record share a trace, and neither quotes the reply", async () => {
    const root = join(dir, "tree");
    const artifact = join(root, "notes.html");
    const record = sessionPaths(artifact);
    await mkdir(join(record.sessionDir, "run"), { recursive: true });
    await writeFile(artifact, DOC);
    await openSession(record);

    const lines: string[] = [];
    const daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath: join(dir, "registry.json"),
      log: (m) => void lines.push(m),
    });
    try {
      // The click: `lucid open` surfaces the session, and the turn it spawns
      // inherits that request's id through LUCID_REQUEST_ID.
      expect((await hubOpen(artifact, daemon.port))?.ok).toBe(true);
      await deliver(record, { t: "agent_reply", id: "r1", text: SECRET });
    } finally {
      await daemon.stop();
    }

    const records = lines
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.event === "request");
    const open = records.find((r) => r.path === "/hub/open");
    const reply = records.find((r) => String(r.path).endsWith("/__lucid/reply"));
    // The join a grep actually runs: one trace, two hops, no shared id.
    expect(open?.trace).toBe(CLICK);
    expect(reply?.trace).toBe(CLICK);
    expect(reply?.id).not.toBe(open?.id);
    // The reply text travelled in the body of the very request being recorded.
    // A record that quoted it would put the review's content in the log (D-005).
    expect(lines.filter((l) => l.includes(SECRET))).toEqual([]);
  });
});
