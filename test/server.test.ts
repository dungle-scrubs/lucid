import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { ensureSessionDirs, openSession } from "../src/core/session.ts";
import { runWait } from "../src/core/wait.ts";
import { readServerDescriptor, writeServerDescriptor } from "../src/server/discovery.ts";
import { runServer } from "../src/server/server.ts";

let dir: string;
let paths: SessionPaths;
let serverDone: Promise<void> | undefined;
let port = 0;

const DOC =
  '<!doctype html><html><head><title>t</title></head><body><h1 data-lucid-id="h">Hello</h1></body></html>';

const startServer = async (): Promise<void> => {
  ensureSessionDirs(paths);
  await openSession(paths);
  serverDone = runServer(paths, [0], { idleMs: 0 });
  // poll for the descriptor (written once bound)
  for (let i = 0; i < 100; i++) {
    const d = await readServerDescriptor(paths);
    if (d) {
      port = d.port;
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("server did not start");
};

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}`, ...headers } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-srv-"));
  paths = sessionPaths(join(dir, "plan.html"));
  await writeFile(paths.artifactPath, DOC);
  // a colocated asset + a secret dotfile + a disallowed type
  await writeFile(join(dir, "logo.png"), "PNGDATA");
  await writeFile(join(dir, "secret.env"), "TOKEN=abc");
});

afterEach(async () => {
  await get("/__lucid/end", {}).catch(() => {});
  await fetch(`http://127.0.0.1:${port}/__lucid/end`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}` },
  }).catch(() => {});
  await serverDone?.catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("server routes + security", () => {
  test("identity, viewer, document, client.js", async () => {
    await startServer();
    const id = await (await get("/__lucid/identity")).json();
    expect(id).toMatchObject({ lucid: true, session: paths.artifactPath });

    const viewer = await (await get("/__lucid/viewer")).text();
    expect(viewer).toContain("<lucid-chrome>");

    const doc = await (await get("/")).text();
    expect(doc).toContain("Hello");
    expect(doc).toContain("__lucid_overlay_root"); // overlay injected
    expect(doc).toContain("/__lucid/client.js");

    const client = await get("/__lucid/client.js");
    expect(client.headers.get("content-type")).toContain("javascript");
  });

  test("serves a colocated allowlisted asset", async () => {
    await startServer();
    const res = await get("/logo.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("rejects dotfile, traversal, bad host, cross-origin, disallowed extension", async () => {
    await startServer();
    expect((await get("/.lucid/plan/log.ndjson")).status).toBe(403); // dotdir
    expect((await get("/secret.env")).status).toBe(403); // disallowed extension
    expect((await get("/%2e%2e/%2e%2e/etc/passwd")).status).toBe(403); // traversal
    expect((await get("/", { host: "evil.com" })).status).toBe(403); // bad host
    expect((await get("/", { origin: "http://evil.com" })).status).toBe(403); // cross-origin
  });

  test("annotation POST lands in the log and reaches wait", async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/__lucid/annotation`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({
        id: "uuid-1",
        version: 1,
        note: "fix this heading",
        target: {
          kind: "element",
          lucidId: "h",
          fingerprint: "x",
          domPath: "h1",
          snippet: "<h1>Hello</h1>",
        },
      }),
    });
    expect(res.status).toBe(200);

    const payload = await runWait(paths, { since: "evt_00001", timeoutMs: 4000 });
    expect(payload.status).toBe("feedback");
    expect(payload.annotations[0]?.note).toBe("fix this heading");
    expect(payload.annotations[0]?.resolved).toBe(true);
  });

  test("idempotent annotation id is not double-recorded", async () => {
    await startServer();
    const body = JSON.stringify({
      id: "dup",
      version: 1,
      note: "once",
      target: { kind: "element", fingerprint: "x", domPath: "h1", snippet: "<h1>Hello</h1>" },
    });
    const headers = { "content-type": "application/json", host: `127.0.0.1:${port}` };
    await fetch(`http://127.0.0.1:${port}/__lucid/annotation`, { method: "POST", headers, body });
    await fetch(`http://127.0.0.1:${port}/__lucid/annotation`, { method: "POST", headers, body });
    const payload = await runWait(paths, { since: "evt_00001", timeoutMs: 2000 });
    expect(payload.annotations).toHaveLength(1);
  });
});

describe("cross-process resume + liveness", () => {
  test("a fresh no-cursor wait returns the full folded current-segment state (D-056)", async () => {
    await startServer();
    await fetch(`http://127.0.0.1:${port}/__lucid/message`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({ id: "m1", text: "hello agent", refs: [] }),
    });
    // Simulate a different harness resuming with no cursor.
    const payload = await runWait(paths, { timeoutMs: 2000 });
    expect(payload.status).toBe("feedback");
    expect(payload.messages.some((m) => m.text === "hello agent")).toBe(true);
  });

  test("an ACTIVE fold with a dead server reports suspended, not block (D-038/D-049)", async () => {
    // No real server; openSession leaves status ACTIVE, descriptor points nowhere.
    ensureSessionDirs(paths);
    await openSession(paths);
    await writeServerDescriptor(paths, {
      port: 59999, // nothing is listening
      pid: 999999,
      session: paths.artifactPath,
      startedAt: new Date().toISOString(),
    });
    const payload = await runWait(paths, { since: "evt_00001", timeoutMs: 2000, pollMs: 50 });
    expect(payload.status).toBe("suspended");
  });
});
