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

const post = (port: number, path: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-hub-"));
  registryPath = join(dir, "registry.json");
  root = join(dir, "tree");
  await mkdir(root, { recursive: true });
  // Hermetic by DEFAULT, not per call site: without this the daemon reads the
  // real `~/.lucid/roots.json`, and every folder the human ever added to their
  // own shell joins these listings. `roots`/`registryPath` are injected at
  // each call; this catches the one that forgets.
  process.env.LUCID_ROOTS = join(dir, "roots.json");
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  delete process.env.LUCID_ROOTS;
  await rm(dir, { recursive: true, force: true });
});

describe("hub daemon", () => {
  test("GET /hub/sessions returns the seeded sessions", async () => {
    const scanned = await seedSession("proj", "notes");
    // Alive pointer: dead ones (no log, no artifact) are pruned by design.
    const registered = join(dir, "loose.html");
    await writeFile(registered, "<h1>loose</h1>");
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

  test("POST /hub/roots adds a folder, reports what it held, and lists it", async () => {
    // The folder is NOT a configured root: it is the "my sessions live
    // somewhere the hub never looks" case the shell has to be able to fix.
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const sessionDir = join(elsewhere, ".lucid", "old-plan");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "log.ndjson"),
      `${JSON.stringify({
        seq: 1,
        at: "2026-01-01T00:00:00.000Z",
        t: "session_opened",
        segment: 1,
        version: 1,
        artifact: "old-plan.html",
        hash: "h",
        path: "versions/s1/v1.html",
      })}\n`,
    );

    const rootsPath = join(dir, "roots.json");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath, rootsPath });

    // Before: the hub cannot see it.
    const before = (await (await get(daemon.port, "/hub/sessions")).json()) as {
      sessions: unknown[];
    };
    expect(before.sessions).toHaveLength(0);

    const res = await post(daemon.port, "/hub/roots", { path: elsewhere });
    expect(res.status).toBe(200);
    const added = (await res.json()) as { root: string; roots: string[]; found: number };
    expect(added.root).toBe(elsewhere);
    expect(added.roots).toContain(elsewhere);
    // The count is what tells the human they picked the right folder.
    expect(added.found).toBe(1);

    // After: the session is listed, without a restart.
    const after = (await (await get(daemon.port, "/hub/sessions")).json()) as {
      sessions: Array<{ artifact: string }>;
    };
    expect(after.sessions.map((s) => s.artifact)).toEqual([
      canonicalArtifactPath(join(elsewhere, "old-plan.html")),
    ]);
  });

  test("a scratchpad session is listed under the project it is ABOUT, not 'scratchpad'", async () => {
    // The layout an agent actually produces: the artifact lives in that
    // agent's session scratchpad, and the project it concerns is encoded in
    // the path. Grouping by the directory gave every such session the project
    // name "scratchpad", which says nothing and collides with every other one.
    const project = join(dir, "dev", "sdlc");
    await mkdir(project, { recursive: true });
    const encoded = project.replaceAll("/", "-").replaceAll(".", "-");
    const pad = join(
      dir,
      "claude-501",
      encoded,
      "40c9c345-b638-4286-bfce-796d9e6fad98",
      "scratchpad",
    );
    const sessionDir = join(pad, ".lucid", "sdlc-flow");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "log.ndjson"),
      `${JSON.stringify({
        seq: 1,
        at: "2026-01-01T00:00:00.000Z",
        t: "session_opened",
        segment: 1,
        version: 1,
        artifact: "sdlc-flow.html",
        hash: "h",
        path: "versions/s1/v1.html",
      })}\n`,
    );

    daemon = await runDaemon({
      port: 0,
      roots: [pad],
      registryPath,
      rootsPath: join(dir, "roots.json"),
    });

    const body = (await (await get(daemon.port, "/hub/sessions")).json()) as {
      sessions: Array<{ artifact: string; project: string }>;
    };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.project).toBe(project);
    // And the artifact still points at where the file really is.
    expect(body.sessions[0]?.artifact).toBe(canonicalArtifactPath(join(pad, "sdlc-flow.html")));
  });

  test("POST /hub/roots answers the whole scanned set, not only the addition", async () => {
    // The shell shows this as "looking in": answering with the persisted
    // additions alone made it forget the defaults the hub still scans.
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      rootsPath: join(dir, "roots.json"),
    });

    const res = await post(daemon.port, "/hub/roots", { path: elsewhere });
    const body = (await res.json()) as { roots: string[] };
    expect(body.roots).toContain(elsewhere);
    expect(body.roots).toContain(root);
  });

  test("POST /hub/roots works on a review-only hub - discovery is not authoring", async () => {
    // Regression: gating this behind attend mode is what left `lucid app`
    // (which starts a review-only hub) with an empty screen and no way out.
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      rootsPath: join(dir, "roots.json"),
      attend: false,
    });

    const res = await post(daemon.port, "/hub/roots", { path: elsewhere });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { found: number }).found).toBe(0);
  });

  test("POST /hub/roots refuses a path that is not an existing directory", async () => {
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      rootsPath: join(dir, "roots.json"),
    });

    const missing = await post(daemon.port, "/hub/roots", { path: join(dir, "nope") });
    expect(missing.status).toBe(400);

    const file = join(dir, "a-file.html");
    await writeFile(file, "<h1>x</h1>");
    const notDir = await post(daemon.port, "/hub/roots", { path: file });
    expect(notDir.status).toBe(400);

    const relative = await post(daemon.port, "/hub/roots", { path: "relative/path" });
    expect(relative.status).toBe(400);
  });

  test("GET /hub/identity reports the scanned roots, added ones included", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const rootsPath = join(dir, "roots.json");
    await writeFile(rootsPath, JSON.stringify([elsewhere]));

    daemon = await runDaemon({ port: 0, roots: [root], registryPath, rootsPath });
    const who = (await (await get(daemon.port, "/hub/identity")).json()) as { roots: string[] };
    expect(who.roots).toEqual([root, elsewhere]);
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
