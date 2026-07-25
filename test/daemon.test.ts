import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactPath, sessionPaths } from "../src/core/paths.ts";
import { registerSession } from "../src/core/registry.ts";
import { runDaemon, sessionId, type DaemonHandle } from "../src/server/daemon.ts";
import type { ServerDescriptor } from "../src/server/discovery.ts";

let dir: string;
let registryPath: string;
let root: string;
let daemon: DaemonHandle | undefined;

const seedSession = async (proj: string, name: string): Promise<string> => {
  const artifact = join(root, proj, `${name}.html`);
  const sessionDir = join(root, proj, ".lucid", name);
  await mkdir(sessionDir, { recursive: true });
  const opened = {
    seq: 1,
    at: "2026-01-01T00:00:00.000Z",
    t: "session_opened",
    segment: 1,
    version: 1,
    artifact: `${name}.html`,
    hash: "h",
    path: "versions/s1/v1.html",
  };
  await writeFile(join(sessionDir, "log.ndjson"), `${JSON.stringify(opened)}\n`);
  return canonicalArtifactPath(artifact);
};

const get = (port: number, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}`, ...headers } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-hub-"));
  registryPath = join(dir, "registry.json");
  root = join(dir, "tree");
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("hub daemon", () => {
  test("GET /hub/sessions returns the seeded sessions", async () => {
    const scanned = await seedSession("proj", "notes");
    const registered = join(dir, "loose.html");
    await registerSession(registered, registryPath);

    daemon = await runDaemon({ port: 0, roots: [root], registryPath });
    expect(daemon.port).toBeGreaterThan(0);

    const res = await get(daemon.port, "/hub/sessions");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { sessions: Array<{ artifact: string; name: string }> };
    const artifacts = body.sessions.map((s) => s.artifact).sort();
    expect(artifacts).toEqual([canonicalArtifactPath(registered), scanned].sort());
  });

  test("GET / serves the shell page booting the chrome in shell mode", async () => {
    await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const res = await get(daemon.port, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("__LUCID_SHELL__");
    expect(html).toContain("/__lucid/chrome.js");
    // No session data is baked into the page: the client fetches the listing.
    expect(html).not.toContain(root);
  });

  test("hub listing carries opaque mount ids, never raw paths in the id", async () => {
    const scanned = await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const res = await get(daemon.port, "/hub/sessions");
    const body = (await res.json()) as { sessions: Array<{ artifact: string; id: string }> };
    const row = body.sessions.find((s) => s.artifact === scanned);
    expect(row).toBeDefined();
    expect(row!.id).toMatch(/^[a-f0-9]{16}$/);
    expect(row!.id).toBe(sessionId(scanned));
  });

  test("/s/<id>/ serves the session's routes off the daemon origin", async () => {
    const scanned = await seedSession("proj", "notes");
    await writeFile(sessionPaths(scanned).currentHtml, "<h1 data-lucid-id='t'>Notes</h1>");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });
    const id = sessionId(scanned);

    const identity = await get(daemon.port, `/s/${id}/__lucid/identity`);
    expect(identity.status).toBe(200);
    const who = (await identity.json()) as { lucid: boolean; session: string };
    expect(who.lucid).toBe(true);
    expect(who.session).toBe(scanned);

    const doc = await get(daemon.port, `/s/${id}/`);
    expect(doc.status).toBe(200);
    expect(await doc.text()).toContain("Notes");

    const state = await get(daemon.port, `/s/${id}/__lucid/state`);
    expect(state.status).toBe(200);
    const folded = (await state.json()) as { version: number };
    expect(folded.version).toBe(1);
  });

  test("mounting writes a descriptor that names the daemon and the base", async () => {
    const scanned = await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });
    const id = sessionId(scanned);

    await get(daemon.port, `/s/${id}/__lucid/identity`);
    const raw = await readFile(sessionPaths(scanned).serverJson, "utf8");
    const desc = JSON.parse(raw) as ServerDescriptor;
    expect(desc.port).toBe(daemon.port);
    expect(desc.pid).toBe(process.pid);
    expect(desc.base).toBe(`/s/${id}`);
  });

  test("POST /hub/open registers, mounts, and answers the shell URL", async () => {
    const artifact = join(root, "proj2", "plan.html");
    await mkdir(join(root, "proj2", ".lucid", "plan"), { recursive: true });
    const opened = {
      seq: 1,
      at: "2026-01-01T00:00:00.000Z",
      t: "session_opened",
      segment: 1,
      version: 1,
      artifact: "plan.html",
      hash: "h",
      path: "versions/s1/v1.html",
    };
    await writeFile(
      join(root, "proj2", ".lucid", "plan", "log.ndjson"),
      `${JSON.stringify(opened)}\n`,
    );
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const res = await fetch(`http://127.0.0.1:${daemon.port}/hub/open`, {
      method: "POST",
      headers: { host: `127.0.0.1:${daemon.port}`, "content-type": "application/json" },
      body: JSON.stringify({ artifact }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; base: string; shell: string };
    expect(body.base).toBe(`/s/${body.id}`);
    expect(body.shell).toContain(`?s=${body.id}`);

    // Mounted eagerly: the descriptor exists and the session answers.
    const identity = await get(daemon.port, `/s/${body.id}/__lucid/identity`);
    expect(identity.status).toBe(200);
  });

  test("an unknown mount id is a 404, not a scan of the filesystem", async () => {
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });
    const res = await get(daemon.port, `/s/${"0".repeat(16)}/__lucid/identity`);
    expect(res.status).toBe(404);
  });

  test("a non-loopback Host is rejected", async () => {
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });
    const res = await get(daemon.port, "/hub/sessions", { host: "evil.com" });
    expect(res.status).toBe(403);
  });

  test("GET /hub/events opens an SSE stream and primes a snapshot", async () => {
    await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const res = await get(daemon.port, "/hub/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !buf.includes('"sessions"')) {
      const { value, done } = await reader!.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    expect(buf).toContain(": connected");
    expect(buf).toContain('"sessions"');
    await reader!.cancel().catch(() => {});
  });
});
