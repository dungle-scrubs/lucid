import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactPath } from "../src/core/paths.ts";
import { registerSession } from "../src/core/registry.ts";
import { runDaemon, type DaemonHandle } from "../src/server/daemon.ts";

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

  test("GET / returns a 200 html placeholder listing the sessions", async () => {
    const scanned = await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const res = await get(daemon.port, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Lucid Hub");
    expect(html).toContain(scanned);
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
