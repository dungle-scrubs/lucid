import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactPath, sessionPaths } from "../src/core/paths.ts";
import { registerSession } from "../src/core/registry.ts";
import { hubOpen, runDaemon, sessionId, type DaemonHandle } from "../src/server/daemon.ts";
import type { ServerDescriptor } from "../src/server/discovery.ts";

let dir: string;
let registryPath: string;
let root: string;
let daemon: DaemonHandle | undefined;

const seedSession = async (proj: string, name: string): Promise<string> => {
  const artifact = join(root, proj, `${name}.html`);
  // The record sits beside its artifact: `notes.html` -> `notes/`.
  const sessionDir = join(root, proj, name);
  await mkdir(join(sessionDir, "run"), { recursive: true });
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
  dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-hub-")));
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

  test("a mounted route's exit record carries the artifact (M3.3, DF-1c)", async () => {
    const scanned = await seedSession("proj", "recorded");
    await writeFile(sessionPaths(scanned).currentHtml, "<h1 data-lucid-id='t'>Recorded</h1>");
    const lines: string[] = [];
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      log: (m) => void lines.push(m),
    });
    const id = sessionId(scanned);
    const res = await get(daemon.port, `/s/${id}/__lucid/identity`);
    expect(res.status).toBe(200);
    // The hub's request log is the sink: one JSON record line per request.
    // Find the exit record for the mounted identity route and assert the
    // artifact identity rode with it (the host attaches it via observation).
    const records = lines
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { artifact?: string; path?: string; status?: number });
    // The exit record (the one with a status) carries the artifact the host
    // attached; the entry record for the same path does not yet.
    const mine = records.find(
      (r) => r.path === `/s/${id}/__lucid/identity` && r.status !== undefined,
    );
    expect(mine, "no exit record for the mounted identity route").toBeDefined();
    expect(mine?.artifact).toBe(scanned);
  });

  /**
   * The stand-in document, in the two states "nothing to serve" can mean.
   *
   * A session is created a beat before its first version is committed, and a
   * viewer that asks in that gap used to be told the file "may have been moved
   * or deleted" - a fabricated cause, delivered at the one moment a human is
   * most likely to be watching. The log knows which state this is, so it says.
   */
  test("the artifact stand-in tells the truth about WHY there is nothing to serve", async () => {
    const opened = await seedSession("proj", "notes"); // log has session_opened
    const fresh = join(root, "proj", "draft.html");
    await mkdir(join(root, "proj", "draft", "run"), { recursive: true });
    await writeFile(join(root, "proj", "draft", "log.ndjson"), ""); // created, never opened
    await registerSession(canonicalArtifactPath(fresh), registryPath);
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const gone = await get(daemon.port, `/s/${sessionId(opened)}/`);
    expect(gone.status).toBe(404);
    const goneBody = await gone.text();
    expect(goneBody).toContain("artifact file is missing");

    const waiting = await get(daemon.port, `/s/${sessionId(canonicalArtifactPath(fresh))}/`);
    expect(waiting.status).toBe(404);
    const waitingBody = await waiting.text();
    expect(waitingBody).toContain("Waiting for this session's first version");
    expect(waitingBody).not.toContain("moved or deleted");

    // Both heal themselves: the frame is sandboxed onto an opaque origin, so a
    // reload is the only way back and nothing outside can trigger it.
    for (const body of [goneBody, waitingBody]) expect(body).toContain("location.reload()");
  });

  /**
   * The listing route answers from cache, and still converges on the disk.
   *
   * Serving the previous answer is only acceptable if the next one arrives on
   * its own: a cache that needed a restart to notice a new session would trade
   * one bug for a worse one.
   */
  test("the session listing is served from cache, and a new session still appears", async () => {
    const scanned = await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const first = await get(daemon.port, "/hub/sessions");
    expect(first.status).toBe(200);
    const before = (await first.json()) as { sessions: Array<{ artifact: string }> };
    expect(before.sessions.map((s) => s.artifact)).toEqual([scanned]);

    // A second session appears on disk. The very next read may legitimately
    // still be the cached answer - that IS the feature - and with no shell
    // connected the only thing that refreshes is a read that finds the value
    // older than POLL_MS, so convergence takes a beat. What it must not take
    // is a restart or a hand-run scan.
    const later = await seedSession("proj", "rollout");
    let listed: string[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && listed.length < 2) {
      const res = await get(daemon.port, "/hub/sessions");
      const body = (await res.json()) as { sessions: Array<{ artifact: string }> };
      listed = body.sessions.map((s) => s.artifact).sort();
      if (listed.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(listed).toEqual([later, scanned].sort());

    // `?fresh=1` skips the wait entirely: the caller that was just told a
    // session exists must see it on the first ask, not the fourth.
    const third = await seedSession("proj", "handoff");
    const forced = await get(daemon.port, "/hub/sessions?fresh=1");
    const now = (await forced.json()) as { sessions: Array<{ artifact: string }> };
    expect(now.sessions.map((s) => s.artifact).sort()).toEqual([later, scanned, third].sort());
  });

  /**
   * The review page under a mount, in BOTH hosting shapes (plan 06).
   *
   * A solo-view URL is held by a chat app's pane across reloads, and a session
   * can legitimately move onto a dedicated server later - the hub quit, an
   * `open` ran, the hub came back. Proxied to that server, the viewer renders
   * for base "" and every URL on the page addresses the hub ROOT: the page
   * loads, `/__lucid/state` 404s, and the review UI sits there inert with no
   * error anywhere.
   */
  test("/s/<id>/__lucid/viewer renders for the MOUNT, not the hub root", async () => {
    const scanned = await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });
    const id = sessionId(scanned);

    const res = await get(daemon.port, `/s/${id}/__lucid/viewer`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The base the page bakes in decides where every later request goes.
    expect(html).toContain(`"base":"/s/${id}"`);
    expect(html).toContain(`"port":${daemon.port}`);
    expect(html).not.toContain('"base":""');
  });

  /**
   * The same page when a DEDICATED server owns the session and the hub only
   * PROXIES - the case the mounted test above cannot reach, and the one that
   * was broken.
   *
   * Proxied, the inner server renders the review page for base "": every URL
   * on it addresses the hub ROOT, `/__lucid/state` 404s, and the page sits
   * there inert with no error anywhere. That mattered little while this URL
   * was only reachable by typing it; the solo view hands it to a chat app's
   * pane, which holds it across reloads.
   *
   * The "dedicated server" here is a stub that answers the handshake, because
   * what is under test is the DAEMON's routing decision - which of the two
   * renders the page - and not the inner server's own output.
   */
  test("/s/<id>/__lucid/viewer renders for the mount even when PROXIED", async () => {
    const scanned = await seedSession("proj", "proxied");
    const paths = sessionPaths(scanned);
    await writeFile(paths.currentHtml, "<h1>Proxied</h1>");

    let innerPort = 0;
    const inner = Bun.serve({
      port: 0,
      fetch: (req): Response => {
        const { pathname } = new URL(req.url);
        if (pathname === "/__lucid/identity") {
          return Response.json({ lucid: true, session: scanned, port: innerPort, version: 1 });
        }
        // What the real dedicated server would answer: rendered for base "".
        return new Response(`<script>window.__LUCID__={"base":"","port":${innerPort}}</script>`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    innerPort = inner.port ?? 0;
    await writeFile(
      paths.serverJson,
      JSON.stringify({ port: inner.port, pid: process.pid, startedAt: new Date(0).toISOString() }),
    );

    try {
      daemon = await runDaemon({ port: 0, roots: [root], registryPath });
      const id = sessionId(scanned);
      const res = await get(daemon.port, `/s/${id}/__lucid/viewer`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`"base":"/s/${id}"`);
      expect(html).toContain(`"port":${daemon.port}`);
      // The tell: the inner server's own answer names neither.
      expect(html).not.toContain('"base":""');
      expect(html).not.toContain(`"port":${inner.port}`);
    } finally {
      inner.stop(true);
    }
  });

  /**
   * The missing artifact, on the PROXIED path, is still a document.
   *
   * `/s/<id>/` renders inside the surface iframe, and the hub answers it
   * itself even when a dedicated server owns the session (the overlay
   * bootstrap has to resolve to the mount). It used to answer that one with
   * `{"error":"artifact not available"}` while the hosted path rendered the
   * self-healing stand-in - raw JSON in the iframe reads as a broken app, and
   * a session whose first version has not landed yet never healed itself.
   */
  test("a PROXIED session with no artifact yet gets the stand-in document, not JSON", async () => {
    const scanned = await seedSession("proj", "proxied");
    const paths = sessionPaths(scanned);

    let innerPort = 0;
    const inner = Bun.serve({
      port: 0,
      fetch: (): Response =>
        Response.json({ lucid: true, session: scanned, port: innerPort, version: 1 }),
    });
    innerPort = inner.port ?? 0;
    await writeFile(
      paths.serverJson,
      JSON.stringify({ port: inner.port, pid: process.pid, startedAt: new Date(0).toISOString() }),
    );

    try {
      daemon = await runDaemon({ port: 0, roots: [root], registryPath });
      const id = sessionId(scanned);
      // The session really is PROXIED and not mounted: a mount would answer
      // identity with the hub's own port, and then this test would be pinning
      // the hosted path it is not about.
      const who = (await (await get(daemon.port, `/s/${id}/__lucid/identity`)).json()) as {
        port: number;
      };
      expect(who.port).toBe(innerPort);

      const res = await get(daemon.port, `/s/${id}/`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("This session's artifact file is missing.");
      expect(html).not.toContain("artifact not available");
    } finally {
      inner.stop(true);
    }
  });

  /**
   * The one place the two wires meet.
   *
   * A session owned by a DEDICATED server is proxied, and a WebSocket
   * handshake cannot be forwarded by fetch. Falling back to SSE for it would
   * put the browser's socket straight back into the six-per-origin pool this
   * whole change exists to get out of - the window is on the HUB's origin
   * either way. So the hub takes the socket itself and relays the inner
   * server's SSE into it.
   */
  test("a PROXIED session's stream is relayed from the dedicated server into the socket", async () => {
    const scanned = await seedSession("proj", "proxied");
    const paths = sessionPaths(scanned);
    await writeFile(paths.currentHtml, "<h1>Proxied</h1>");

    let innerPort = 0;
    let endStream: (() => void) | undefined;
    const inner = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (req): Response => {
        const { pathname } = new URL(req.url);
        if (pathname === "/__lucid/identity") {
          return Response.json({ lucid: true, session: scanned, port: innerPort, version: 1 });
        }
        if (pathname === "/__lucid/events") {
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode(": connected\n\n"));
                controller.enqueue(encoder.encode('data: {"t":"from-the-inner-server"}\n\n'));
                controller.enqueue(encoder.encode('event: warning\ndata: {"code":"INNER"}\n\n'));
                endStream = () => controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream; charset=utf-8" } },
          );
        }
        return new Response("no", { status: 404 });
      },
    });
    innerPort = inner.port ?? 0;
    await writeFile(
      paths.serverJson,
      JSON.stringify({ port: inner.port, pid: process.pid, startedAt: new Date(0).toISOString() }),
    );

    try {
      daemon = await runDaemon({ port: 0, roots: [root], registryPath });
      const id = sessionId(scanned);
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/s/${id}/__lucid/events`);
      const frames: { event: string | null; data: string }[] = [];
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("upgrade failed"));
        setTimeout(() => reject(new Error("upgrade timed out")), 4000);
      });

      // Both frame shapes survive the crossing: SSE's default `data:`-only
      // frame becomes a null event, and a named one keeps its name. The
      // ": connected" comment is not a frame and must not become one.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && frames.length < 2) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(frames.find((f) => f.event === null)?.data).toContain("from-the-inner-server");
      expect(frames.find((f) => f.event === "warning")?.data).toContain("INNER");
      expect(frames.some((f) => f.data.includes("connected"))).toBe(false);

      // When the inner stream ENDS, the window is asked to come back rather
      // than left on a socket nothing will ever write to again - its reconnect
      // re-runs the proxy-or-mount decision.
      endStream?.();
      const closing = Date.now() + 4000;
      while (Date.now() < closing && !frames.some((f) => f.event === "reconnect")) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(frames.some((f) => f.event === "reconnect")).toBe(true);
      ws.close();
    } finally {
      inner.stop(true);
    }
  });

  test("a dedicated server that stalls its stream gets the upgrade REFUSED, not a live socket", async () => {
    const scanned = await seedSession("proj", "stalled");
    const paths = sessionPaths(scanned);
    await writeFile(paths.currentHtml, "<h1>Stalled</h1>");

    let innerPort = 0;
    const inner = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (req): Response | Promise<Response> => {
        const { pathname } = new URL(req.url);
        if (pathname === "/__lucid/identity") {
          return Response.json({ lucid: true, session: scanned, port: innerPort, version: 1 });
        }
        // Answers the probe, then never answers its stream - the state that
        // used to leave a window on a socket nothing would ever write to,
        // reporting live, with the proxy-or-mount decision never re-run.
        if (pathname === "/__lucid/events") return new Promise<Response>(() => {});
        return new Response("no", { status: 404 });
      },
    });
    innerPort = inner.port ?? 0;
    await writeFile(
      paths.serverJson,
      JSON.stringify({ port: inner.port, pid: process.pid, startedAt: new Date(0).toISOString() }),
    );

    try {
      daemon = await runDaemon({ port: 0, roots: [root], registryPath, relayOpenMs: 250 });
      const id = sessionId(scanned);
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/s/${id}/__lucid/events`);
      // The socket must never open: an open one is the shell's signal that it
      // is subscribed, and it would not be. Refusing sends it round the
      // reconnect loop instead, which re-runs the decision.
      const outcome = await new Promise<string>((resolve) => {
        ws.onopen = () => resolve("opened");
        ws.onclose = () => resolve("refused");
        ws.onerror = () => resolve("refused");
        setTimeout(() => resolve("hung"), 4000);
      });
      expect(outcome).toBe("refused");
      ws.close();
    } finally {
      inner.stop(true);
    }
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
    const artifact = join(root, "proj2", ".lucid", "plan.html");
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
      canonicalArtifactPath(join(elsewhere, ".lucid", "old-plan.html")),
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
    expect(body.sessions[0]?.artifact).toBe(
      canonicalArtifactPath(join(pad, ".lucid", "sdlc-flow.html")),
    );
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

  test("/hub/events upgrades to a WebSocket and primes the same two frames", async () => {
    await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/hub/events`);
    const frames: { event: string | null; data: string }[] = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("upgrade failed"));
      setTimeout(() => reject(new Error("upgrade timed out")), 4000);
    });

    // Priming is what makes a fresh window paint without waiting for the poll
    // to find a change - an upgraded window must get it too.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && frames.length < 2) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const listing = frames.find((f) => f.event === null);
    expect(listing?.data).toContain('"sessions"');
    expect(frames.some((f) => f.event === "attention")).toBe(true);
    ws.close();
  });

  test("a shell window's socket counts as a subscriber, so the listing keeps polling", async () => {
    await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    // `shells` is what the CLI reads to decide whether a window took an open;
    // it is the subscriber count, and an upgraded window is a subscriber.
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/hub/events`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("upgrade failed"));
      setTimeout(() => reject(new Error("upgrade timed out")), 4000);
    });
    const identity = (await get(daemon.port, "/hub/identity").then((r) => r.json())) as {
      shells: number;
    };
    expect(identity.shells).toBe(1);
    ws.close();
  });

  test("a hub with an open shell socket still shuts down", async () => {
    await seedSession("proj", "notes");
    const hub = await runDaemon({ port: 0, roots: [root], registryPath });
    daemon = hub;
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/hub/events`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("upgrade failed"));
      setTimeout(() => reject(new Error("upgrade timed out")), 4000);
    });

    // The guard on RECONNECT_FRAME's reason (live.ts): a hub that closes a
    // WebSocket itself can never stop again - `server.stop()` simply does not
    // resolve (Bun 1.3.14). This asserts the shutdown path never does that.
    // Without the deadline the failure mode is a hung suite, not a red test.
    await Promise.race([
      hub.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("stop() hung")), 5000)),
    ]);
    daemon = undefined;
    ws.close();
  });

  test("attention rides its own SSE event; the listing stays byte-identical when an agent works (R3, M1.2)", async () => {
    await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    const reader = (await get(daemon.port, "/hub/events")).body?.getReader();
    if (!reader) throw new Error("no SSE body");
    const decoder = new TextDecoder();
    const readUntil = async (pred: (b: string) => boolean, ms = 4000): Promise<string> => {
      let buf = "";
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !pred(buf)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      return buf;
    };

    // Primed with BOTH the listing and a (working:false) attention frame.
    const primed = await readUntil((b) => b.includes("event: attention"));
    expect(primed).toContain('"sessions"');
    expect(primed).toContain("event: attention");
    expect(primed).not.toContain('"working":true');

    // The agent starts a turn: an ack with no output after it opens the window.
    const logPath = join(root, "proj", "notes", "log.ndjson");
    const ack = { seq: 2, at: "2026-01-01T00:00:01.000Z", t: "agent_ack", segment: 1 };
    await writeFile(logPath, `${await readFile(logPath, "utf8")}${JSON.stringify(ack)}\n`);

    const after = await readUntil((b) => b.includes('"working":true'));
    expect(after).toContain("event: attention");
    expect(after).toContain('"working":true'); // the ATTENTION frame carries it
    // R3: the working state rides the attention event ONLY; the listing row
    // never carries it. (Folding `working` into the listing row reds this.) A
    // listing frame may still re-send for its own reasons (a `lastSeen` bump),
    // so assert the ABSENCE of `working` in the listing, not the frame's.
    const listingFrames = after
      .split("\n\n")
      .filter((f) => f.startsWith("data: ") && f.includes('"sessions"'));
    for (const f of listingFrames) expect(f).not.toContain('"working"');

    await reader.cancel().catch(() => {});
  });

  test("the attention fold cache exposes hit/miss on the hub debug surface (M1.1)", async () => {
    await seedSession("proj", "notes");
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });

    // Connect a shell and let the prime fold attention at least once.
    const reader = (await get(daemon.port, "/hub/events")).body?.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 4000;
    let buf = "";
    while (Date.now() < deadline && !buf.includes("event: attention")) {
      const { value, done } = await reader!.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }

    const identity = (await (await get(daemon.port, "/hub/identity")).json()) as {
      debug?: { sessionStateCache?: { hits: number; misses: number; entries: number } };
    };
    expect(identity.debug?.sessionStateCache).toBeDefined();
    expect(identity.debug?.sessionStateCache?.misses).toBeGreaterThanOrEqual(1);
    await reader!.cancel().catch(() => {});
  });
});

describe("the hub's wide event: every request emits (plan 07, M1.2)", () => {
  const records = (lines: string[]) =>
    lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);

  test("a listing request emits entry and exit: status 200, a real duration, one id", async () => {
    const lines: string[] = [];
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      log: (m) => void lines.push(m),
    });
    const res = await get(daemon.port, "/hub/sessions");
    expect(res.status).toBe(200);

    const entry = records(lines).find(
      (r) => r.event === "request.start" && r.path === "/hub/sessions",
    );
    const exit = records(lines).find((r) => r.event === "request" && r.path === "/hub/sessions");
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    expect(exit?.status).toBe(200);
    expect(exit?.durationMs as number).toBeGreaterThan(0);
    expect(exit?.id).toBe(entry?.id);
  });

  test("an unknown path emits its 404 - the miss is evidence too", async () => {
    const lines: string[] = [];
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      log: (m) => void lines.push(m),
    });
    await get(daemon.port, "/no/such/route");

    const exit = records(lines).find((r) => r.event === "request" && r.path === "/no/such/route");
    expect(exit?.status).toBe(404);
  });

  test("a refused create carries only what EARNED the name of an identifier", async () => {
    // Tightened by plan 08 M11 (07#12). Every field on this record is now
    // attached after the check that makes it real, so a refused create cannot
    // be a channel for arbitrary caller text.
    const lines: string[] = [];
    const harnesses = join(dir, "harnesses.json");
    await writeFile(
      harnesses,
      JSON.stringify({
        default: "claude",
        harnesses: { claude: { spawn: ["true"], resume: ["true"] } },
      }),
    );
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      harnessesPath: harnesses,
      attend: true,
      log: (m) => void lines.push(m),
    });
    await post(daemon.port, "/hub/create", {
      project: root,
      name: "not a valid name!",
      prompt: "SENTINEL_PROMPT_never_logged",
      harness: "claude",
    });

    const exit = records(lines).find((r) => r.event === "request" && r.path === "/hub/create");
    // Rooted, so it names a place this hub actually scans.
    expect(exit?.project).toBe(root);
    // The registry recognises it, so it is a harness and not caller text.
    expect(exit?.harness).toBe("claude");
    // A name that fails CREATE_NAME is whatever the caller typed, which could
    // be content. It never reaches the record.
    expect(exit?.artifact).toBeUndefined();
    expect(lines.join("\n")).not.toContain("not a valid name!");
    expect(lines.join("\n")).not.toContain("SENTINEL_PROMPT_never_logged");
  });

  test("an unvouched project or harness never reaches the record (07#12)", async () => {
    // The half that was open: with no registry nothing can vouch for the
    // harness string, and an unrooted project is just a path the caller typed.
    // Both used to be attached before any check ran, putting ~256 bytes of
    // arbitrary text into a retained record on every refused create.
    const lines: string[] = [];
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      attend: true,
      log: (m) => void lines.push(m),
    });
    await post(daemon.port, "/hub/create", {
      project: "/nowhere/SENTINEL_PROJECT_never_logged",
      name: "ok.html",
      prompt: "hello",
      harness: "SENTINEL_HARNESS_never_logged",
    });

    const exit = records(lines).find((r) => r.event === "request" && r.path === "/hub/create");
    expect(exit?.status).toBe(400);
    expect(exit?.project).toBeUndefined();
    expect(exit?.harness).toBeUndefined();
    expect(lines.join("\n")).not.toContain("SENTINEL_PROJECT_never_logged");
    expect(lines.join("\n")).not.toContain("SENTINEL_HARNESS_never_logged");
  });

  test("a session route attaches the session id where the route knows it", async () => {
    const artifact = await seedSession("proj", "notes");
    const id = sessionId(artifact);
    const lines: string[] = [];
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      log: (m) => void lines.push(m),
    });
    await get(daemon.port, `/s/${id}/`);

    const exit = records(lines).find((r) => r.event === "request" && r.session === id);
    expect(exit).toBeDefined();
  });
});

describe("the verbose flag governs internal narration ONLY (M3.1)", () => {
  test("with LUCID_VERBOSE unset, the boundary records still emit - they are baseline evidence", async () => {
    const prev = process.env.LUCID_VERBOSE;
    delete process.env.LUCID_VERBOSE;
    const lines: string[] = [];
    try {
      daemon = await runDaemon({
        port: 0,
        roots: [root],
        registryPath,
        log: (m) => void lines.push(m),
      });
      await get(daemon.port, "/hub/sessions");
    } finally {
      if (prev !== undefined) process.env.LUCID_VERBOSE = prev;
    }
    const records = lines
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // Read as a blanket silence rule, technique 4 would cancel technique 2 and
    // leave a program that emits nothing and calls that observability.
    expect(records.find((r) => r.event === "request.start")).toBeDefined();
    expect(records.find((r) => r.event === "request")).toBeDefined();
  });

  test("narration and records share the sink WITHOUT corrupting each other", async () => {
    const prev = process.env.LUCID_VERBOSE;
    process.env.LUCID_VERBOSE = "all";
    const lines: string[] = [];
    try {
      daemon = await runDaemon({
        port: 0,
        roots: [root],
        registryPath,
        log: (m) => void lines.push(m),
      });
      await get(daemon.port, "/hub/sessions");
      // Narration really is live in this process - asserting on a route that
      // narrates nothing left the whole test passing because NOTHING was
      // tracing, which is what the flag being import-time-snapshotted did.
      const { tracer } = await import("../src/core/verbose.ts");
      tracer("attend")(() => "synthetic: a turn declined");
    } finally {
      if (prev === undefined) delete process.env.LUCID_VERBOSE;
      else process.env.LUCID_VERBOSE = prev;
    }

    // The hub installs its own log as the narration sink, so both land here.
    const narration = lines.filter((l) => l.startsWith("[attend]"));
    expect(narration.length).toBeGreaterThan(0);

    // And the records are untouched by it: still exactly one exit for the
    // request, and every JSON line still parses - a reader grepping the file
    // is never handed a half-line spliced with a trace.
    const records = lines.filter((l) => l.startsWith("{"));
    for (const line of records) expect(() => JSON.parse(line)).not.toThrow();
    const exits = records
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.event === "request" && r.path === "/hub/sessions");
    expect(exits).toHaveLength(1);
  });
});

describe("the CLI carries the id to the hub (M1.3)", () => {
  test("hubOpen sends x-lucid-request, adopting LUCID_REQUEST_ID when a turn holds one", async () => {
    const artifact = await seedSession("proj", "notes");
    const lines: string[] = [];
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      log: (m) => void lines.push(m),
    });
    const prev = process.env.LUCID_REQUEST_ID;
    process.env.LUCID_REQUEST_ID = "0123456789abcdef";
    try {
      const result = await hubOpen(artifact, daemon.port);
      expect(result?.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LUCID_REQUEST_ID;
      else process.env.LUCID_REQUEST_ID = prev;
    }

    const exit = lines
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.event === "request" && r.path === "/hub/open");
    // The turn's own hub call joins the click that spawned it - one grep.
    expect(exit?.trace).toBe("0123456789abcdef");
    expect(exit?.id).not.toBe("0123456789abcdef");
  });
});

describe("no request escapes the record (adversarial review of #89)", () => {
  test("an authority-form target (CONNECT) still emits entry and exit", async () => {
    const lines: string[] = [];
    daemon = await runDaemon({
      port: 0,
      roots: [root],
      registryPath,
      log: (m) => void lines.push(m),
    });
    // fetch cannot send CONNECT; write the raw request line ourselves.
    const { connect } = await import("node:net");
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(daemon?.port ?? 0, "127.0.0.1", () => {
        sock.write(
          `CONNECT 127.0.0.1:${daemon?.port} HTTP/1.1\r\nHost: 127.0.0.1:${daemon?.port}\r\n\r\n`,
        );
      });
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
      });
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
      setTimeout(() => {
        sock.end();
      }, 1500);
    });
    expect(raw).toContain("HTTP/1.1");

    const records = lines
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const entry = records.find((r) => r.event === "request.start" && r.method === "CONNECT");
    const exit = records.find((r) => r.event === "request" && r.method === "CONNECT");
    // The unparseable target rides as the raw string - evidence beats purity.
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
  });
});

// ---- M5.4 coexistence + regression tests --------------------------------

test("coexistence: the daemon HOSTS when no dedicated server is live", async () => {
  const scanned = await seedSession("proj", "hosted-session");
  daemon = await runDaemon({ port: 0, roots: [root], registryPath });
  const id = sessionId(scanned);
  // No server descriptor: nothing to discover, so the daemon hosts.
  const res = await get(daemon.port, `/s/${id}/__lucid/identity`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { session: string; port: number };
  expect(body.session).toBe(scanned);
  expect(body.port).toBe(daemon.port);
  // The descriptor the mount wrote names THIS daemon.
  const paths = sessionPaths(scanned);
  const desc = JSON.parse(await Bun.file(paths.serverJson).text()) as {
    port: number;
    pid: number;
  };
  expect(desc.port).toBe(daemon.port);
  expect(desc.pid).toBe(process.pid);
});

test("coexistence: the daemon PROXIES to a live dedicated server", async () => {
  const scanned = await seedSession("proj", "proxied-session");
  const paths = sessionPaths(scanned);

  // A stub dedicated server that answers identity with its own port.
  let innerPort = 0;
  const inner = Bun.serve({
    port: 0,
    fetch: (req): Response => {
      const { pathname } = new URL(req.url);
      if (pathname === "/__lucid/identity")
        return Response.json({ lucid: true, session: scanned, port: innerPort, version: 1 });
      return new Response("inner server response", {
        headers: { "content-type": "text/plain" },
      });
    },
  });
  innerPort = inner.port ?? 0;

  // Write a descriptor pointing to the stub: the daemon should discover it
  // and proxy, not host.
  await writeFile(
    paths.serverJson,
    JSON.stringify({ port: inner.port, pid: process.pid, startedAt: new Date(0).toISOString() }),
  );

  try {
    daemon = await runDaemon({ port: 0, roots: [root], registryPath });
    const id = sessionId(scanned);
    const res = await get(daemon.port, `/s/${id}/__lucid/state`);
    // The stub answers with plain text; a mount would answer with JSON.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("inner server response");
  } finally {
    inner.stop();
  }
});

test("regression: a stale descriptor naming our own port does not cause route recursion", async () => {
  const scanned = await seedSession("proj", "stale-descriptor");
  const paths = sessionPaths(scanned);

  // Start the daemon first so we know its port.
  daemon = await runDaemon({ port: 0, roots: [root], registryPath });

  // Write a descriptor naming the DAEMON'S OWN port but with no mount behind
  // it - exactly what a previous hub life on the same port leaves behind.
  await writeFile(
    paths.serverJson,
    JSON.stringify({
      port: daemon.port,
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
    }),
  );

  // Request the session: the daemon must short-circuit the stale descriptor
  // (port matches our own) and mount, not discover-and-recurse.
  const id = sessionId(scanned);
  const res = await get(daemon.port, `/s/${id}/__lucid/identity`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { session: string; port: number };
  // If this answered, there was no recursion (recursion would hang or 500).
  expect(body.port).toBe(daemon.port);
});
