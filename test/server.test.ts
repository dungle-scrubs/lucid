import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttendantSidecar } from "../src/core/attendant.ts";
import { readContextSidecar } from "../src/core/context.ts";
import { runContext } from "../src/cli/run.ts";
import { foldLog } from "../src/core/fold.ts";
import { readEvents } from "../src/core/log.ts";
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
    expect(viewer).toContain('<div id="lucid-root">'); // the React chrome mounts here
    expect(viewer).toContain("/__lucid/chrome.js");
    expect(viewer).toContain("/__lucid/chrome.css");

    const doc = await (await get("/")).text();
    expect(doc).toContain("Hello");
    expect(doc).toContain("__lucid_overlay_root"); // overlay injected
    // The artifact gets the overlay bundle only. Serving it the chrome would
    // push React into a sandboxed document Lucid does not own.
    expect(doc).toContain("/__lucid/client.js");
    expect(doc).not.toContain("/__lucid/chrome.js");

    const client = await get("/__lucid/client.js");
    expect(client.headers.get("content-type")).toContain("javascript");
    const chromeJs = await get("/__lucid/chrome.js");
    expect(chromeJs.headers.get("content-type")).toContain("javascript");
    const chromeCss = await get("/__lucid/chrome.css");
    expect(chromeCss.headers.get("content-type")).toContain("css");
  });

  test("lists sibling sessions for the current project", async () => {
    const siblingPaths = sessionPaths(join(dir, "notes.html"));
    await writeFile(siblingPaths.artifactPath, DOC);
    await openSession(siblingPaths);
    await writeAttendantSidecar(siblingPaths, {
      harness: "codex",
      nextCursor: "evt_00001",
      at: "2026-07-16T10:00:00.000Z",
      resume: "codex resume sibling",
    });
    await startServer();

    const response = await get("/__lucid/sessions");
    const listing = (await response.json()) as {
      root: string;
      current: string;
      sessions: Array<{
        session: string;
        live: boolean;
        viewer?: string;
        resume?: string;
        lastAttendant?: { harness: string; at: string; resume?: string };
      }>;
    };

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(listing.root).toBe(dir);
    expect(listing.current).toBe(paths.artifactPath);
    expect(listing.sessions).toHaveLength(2);
    expect(listing.sessions[0]).toMatchObject({
      session: paths.artifactPath,
      live: true,
      viewer: `http://127.0.0.1:${port}/__lucid/viewer`,
    });
    expect(listing.sessions[1]).toMatchObject({
      session: siblingPaths.artifactPath,
      live: false,
      resume: `lucid open ${siblingPaths.artifactPath}`,
      lastAttendant: {
        harness: "codex",
        at: "2026-07-16T10:00:00.000Z",
        resume: "codex resume sibling",
      },
    });
  });

  test("browser auto-probes are answered without a missing-asset warning", async () => {
    await startServer();
    const fav = await get("/favicon.ico");
    expect(fav.status).toBe(200);
    expect(fav.headers.get("content-type")).toBe("image/svg+xml");
    expect((await get("/apple-touch-icon.png")).status).toBe(204);
    expect((await get("/robots.txt")).status).toBe(204);
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

  test("pasted image: upload, serve, and reach the agent in a message", async () => {
    await startServer();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const up = await fetch(`http://127.0.0.1:${port}/__lucid/asset`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        host: `127.0.0.1:${port}`,
        "x-lucid-filename": "shot.png",
      },
      body: png,
    });
    expect(up.status).toBe(200);
    const meta = (await up.json()) as { id: string; name: string; file: string };
    expect(meta.file).toMatch(/\.png$/);

    const served = await get(`/__lucid/asset/${meta.file}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");

    await fetch(`http://127.0.0.1:${port}/__lucid/message`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({ id: "m-img", text: "see this", refs: [], images: [meta] }),
    });

    const payload = await runWait(paths, { since: "evt_00001", timeoutMs: 3000 });
    const msg = payload.messages.find((m) => m.text === "see this");
    expect(msg?.images?.[0]?.name).toBe("shot.png");
    // The agent reads bytes off disk...
    expect(msg?.images?.[0]?.path).toContain("/pasted/");
    // ...and the viewer builds /__lucid/asset/<file>, so both must survive.
    expect(msg?.images?.[0]?.file).toBe(meta.file);
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

  test("multi-target annotation: target derives as first, full list reaches wait", async () => {
    await startServer();
    const spot = (n: number) => ({
      kind: "element",
      ...(n === 1 ? { lucidId: "h" } : {}),
      fingerprint: `f${n}`,
      domPath: n === 1 ? "h1" : `p:nth-child(${n})`,
      snippet: `<p>spot ${n}</p>`,
    });
    const res = await fetch(`http://127.0.0.1:${port}/__lucid/annotation`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({
        id: "multi-1",
        version: 1,
        note: "align these three",
        targets: [spot(1), spot(2), spot(3)],
      }),
    });
    expect(res.status).toBe(200);

    // The stored event carries the FULL list with `target` equal to its first,
    // so a legacy reader sees the first spot.
    const events = (await readEvents(paths.logPath)).events;
    const stored = events.find((e) => e.t === "annotation" && e.id === "multi-1");
    expect(stored && "targets" in stored ? stored.targets?.length : 0).toBe(3);
    expect(stored && "target" in stored ? stored.target : undefined).toEqual(
      stored && "targets" in stored ? stored.targets?.[0] : undefined,
    );

    const payload = await runWait(paths, { since: "evt_00001", timeoutMs: 4000 });
    const a = payload.annotations.find((x) => x.id === "multi-1");
    expect(a?.targets).toHaveLength(3);
    expect(a?.target).toEqual(a?.targets?.[0]);
    // The first spot resolves (lucidId "h"), so the record stays live even
    // though the collected extras point at nothing in this document.
    expect(a?.resolved).toBe(true);
  });

  test("a singleton targets list normalizes to the canonical single form", async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/__lucid/annotation`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({
        id: "single-1",
        version: 1,
        note: "just this one",
        targets: [
          { kind: "element", lucidId: "h", fingerprint: "x", domPath: "h1", snippet: "<h1></h1>" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const events = (await readEvents(paths.logPath)).events;
    const stored = events.find((e) => e.t === "annotation" && e.id === "single-1");
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("targets");
    const target = stored && "target" in stored ? stored.target : undefined;
    expect(target?.kind === "element" ? target.domPath : undefined).toBe("h1");
  });

  test("multi-target annotation rejects over-cap and any invalid element", async () => {
    await startServer();
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/__lucid/annotation`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });
    const good = { kind: "element", fingerprint: "f", domPath: "h1", snippet: "s" };

    const over = await post({
      id: "cap-1",
      version: 1,
      note: "too many",
      targets: Array.from({ length: 9 }, () => good),
    });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toContain("max 8");

    // One malformed element rejects the WHOLE list - a note must never claim
    // spots the log does not have.
    const bad = await post({
      id: "bad-1",
      version: 1,
      note: "one bad apple",
      targets: [good, { kind: "element", fingerprint: "f" }],
    });
    expect(bad.status).toBe(400);

    const events = (await readEvents(paths.logPath)).events;
    expect(events.some((e) => e.t === "annotation")).toBe(false);
  });

  test("answer anchors: first derives as anchor, all pins fold, singleton normalizes", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });
    const pin = (n: number) => ({
      kind: "element",
      fingerprint: `f${n}`,
      domPath: `h${n}`,
      snippet: `<h${n}>pin</h${n}>`,
    });

    await post("/__lucid/question", { id: "q1", text: "Which sections apply?" });
    const ok = await post("/__lucid/answer", {
      id: "a1",
      questionId: "q1",
      text: "these two",
      anchors: [pin(1), pin(2)],
    });
    expect(ok.status).toBe(200);
    let state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].answerAnchors).toHaveLength(2);
    expect(state.questions[0].answerAnchor).toEqual(state.questions[0].answerAnchors[0]);

    // A single pin sent through `anchors` stores in the shape a single pin
    // has always had: `anchor` only, no list field.
    await post("/__lucid/question", { id: "q2", text: "And this one?" });
    await post("/__lucid/answer", { id: "a2", questionId: "q2", text: "here", anchors: [pin(1)] });
    const events = (await readEvents(paths.logPath)).events;
    const answered = events.find((e) => e.t === "question_answered" && e.questionId === "q2");
    expect(answered).toBeDefined();
    expect(answered).not.toHaveProperty("anchors");
    state = await (await get("/__lucid/state")).json();
    expect(state.questions[1].answerAnchor.domPath).toBe("h1");
    expect(state.questions[1]).not.toHaveProperty("answerAnchors");

    // Over-cap is refused like an annotation's.
    await post("/__lucid/question", { id: "q3", text: "All of them?" });
    const over = await post("/__lucid/answer", {
      id: "a3",
      questionId: "q3",
      text: "everywhere",
      anchors: Array.from({ length: 9 }, () => pin(1)),
    });
    expect(over.status).toBe(400);
  });

  test("skip and re-ask discard answer anchors like every other decision", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });
    const pin = { kind: "element", fingerprint: "f", domPath: "h1", snippet: "<h1>pin</h1>" };

    await post("/__lucid/question", { id: "q-skip", text: "Ship it?" });
    await post("/__lucid/answer", {
      id: "a-skip",
      questionId: "q-skip",
      text: "",
      skipped: true,
      anchors: [pin, pin],
    });
    await post("/__lucid/question", { id: "q-unclear", text: "Thoughts on the frobnitz?" });
    await post("/__lucid/answer", {
      id: "a-unclear",
      questionId: "q-unclear",
      text: "what is a frobnitz",
      unclear: true,
      anchors: [pin, pin],
    });

    const state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].skipped).toBe(true);
    expect(state.questions[0]).not.toHaveProperty("answerAnchor");
    expect(state.questions[0]).not.toHaveProperty("answerAnchors");
    expect(state.questions[1].unclear).toBe(true);
    expect(state.questions[1]).not.toHaveProperty("answerAnchor");
    expect(state.questions[1]).not.toHaveProperty("answerAnchors");
  });

  test("fork POST lands in the log and reaches wait as feedback", async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/__lucid/fork`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({
        id: "fork-1",
        version: 1,
        note: "turn this into an implementation plan",
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
    expect(payload.annotations.length).toBe(0);
    expect(payload.forks?.length).toBe(1);
    expect(payload.forks?.[0]?.note).toBe("turn this into an implementation plan");
    expect(payload.forks?.[0]?.resolved).toBe(true);
  });

  test("fork POST rejects an empty directive and a blank id", async () => {
    await startServer();
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/__lucid/fork`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });
    const target = { kind: "element", lucidId: "h", fingerprint: "x", domPath: "h1", snippet: "s" };
    expect((await post({ id: "fork-2", version: 1, note: "   ", target })).status).toBe(400);
    // A blank id would collide in the shared dedupe set, so it is refused.
    expect((await post({ id: "  ", version: 1, note: "spin off", target })).status).toBe(400);
    // The id becomes a filesystem path component in the launcher, so path
    // traversal / separators are refused at the boundary.
    expect((await post({ id: "../../evil", version: 1, note: "x", target })).status).toBe(400);
    expect((await post({ id: "a/b", version: 1, note: "x", target })).status).toBe(400);
  });

  test("two fork POSTs with the same id dedupe to one (D-057 backstop)", async () => {
    await startServer();
    const body = JSON.stringify({
      id: "same-fork",
      version: 1,
      note: "spin off a plan",
      target: { kind: "element", lucidId: "h", fingerprint: "x", domPath: "h1", snippet: "s" },
    });
    const headers = { "content-type": "application/json", host: `127.0.0.1:${port}` };
    await fetch(`http://127.0.0.1:${port}/__lucid/fork`, { method: "POST", headers, body });
    await fetch(`http://127.0.0.1:${port}/__lucid/fork`, { method: "POST", headers, body });
    const payload = await runWait(paths, { since: "evt_00001", timeoutMs: 3000 });
    expect(payload.forks?.length).toBe(1);
  });

  test("fork POST carries pasted images through to wait", async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/__lucid/fork`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({
        id: "fork-img",
        version: 1,
        note: "build this mockup",
        target: { kind: "element", lucidId: "h", fingerprint: "x", domPath: "h1", snippet: "s" },
        images: [{ id: "i1", name: "mock.png", file: "a1b2c3.png" }],
      }),
    });
    expect(res.status).toBe(200);
    const payload = await runWait(paths, { since: "evt_00001", timeoutMs: 4000 });
    expect(payload.forks?.[0]?.images?.[0]?.name).toBe("mock.png");
    // Addressed for the agent to read off disk (absolute path into the session).
    expect(payload.forks?.[0]?.images?.[0]?.path).toContain("a1b2c3.png");
  });

  test("attendant stamps ride agent events and fold into session history (D18)", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/ack", {
      id: "ack-st-1",
      attendant: { harness: "claude_code", sessionId: "sess-9", cwd: "/proj" },
    });
    await post("/__lucid/reply", {
      id: "r-st-1",
      text: "done",
      attendant: { harness: "claude_code", sessionId: "sess-9", cwd: "/proj" },
    });
    // A malformed stamp is dropped, never trusted or echoed.
    await post("/__lucid/reply", {
      id: "r-st-2",
      text: "again",
      attendant: { harness: "", sessionId: 42 },
    });

    const state = foldLog((await readEvents(paths.logPath)).events);
    const hist = state.sessionHistory.filter((h) => h.sessionId === "sess-9");
    expect(hist).toHaveLength(1);
    expect(hist[0]?.harness).toBe("claude_code");
    expect(hist[0]?.events).toBe(2);
    expect(hist[0]?.cwd).toBe("/proj");

    // The state payload exposes the derived history to the viewer.
    const res = await fetch(`http://127.0.0.1:${port}/__lucid/state`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    const payload = (await res.json()) as {
      sessionHistory?: { harness: string; sessionId?: string }[];
    };
    expect(payload.sessionHistory?.some((h) => h.sessionId === "sess-9")).toBe(true);
  });

  test("agent_ack opens the working window, output closes it, waiters stay asleep", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/ack", { id: "ack-1" });
    let state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.agentWorking).toBeTruthy();
    expect(state.agentWorking?.intent).toBeUndefined();

    // A re-ack declares intent without restarting the window's clock.
    const since = state.agentWorking?.since;
    await post("/__lucid/ack", { id: "ack-2", intent: "revise" });
    state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.agentWorking?.intent).toBe("revise");
    expect(state.agentWorking?.since).toBe(since!);

    // An ack-only delta must not wake a waiting agent: acks are presence
    // metadata, not feedback, and agents must not wake each other by
    // acknowledging. The wait should run its full window.
    const t0 = Date.now();
    const w = await runWait(paths, { since: "evt_00001", timeoutMs: 900 });
    expect(w.status).toBe("waiting");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);

    // Any agent output closes the window.
    await post("/__lucid/reply", { id: "r-1", text: "done" });
    state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.agentWorking).toBeNull();
  });

  test("ack carries self-reported fan-out progress through to the folded window", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    // `lucid progress` delivers an ack whose body carries a progress struct.
    await post("/__lucid/ack", {
      id: "p-1",
      progress: { label: "auditing 7 screens", total: 7, done: 0 },
    });
    let state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.agentWorking?.progress).toEqual({
      label: "auditing 7 screens",
      total: 7,
      done: 0,
    });

    // A later report bumps done in place (last-writer-wins, clock unchanged).
    const since = state.agentWorking?.since;
    await post("/__lucid/ack", {
      id: "p-2",
      progress: { label: "auditing 7 screens", total: 7, done: 3 },
    });
    state = foldLog((await readEvents(paths.logPath)).events);
    expect(state.agentWorking?.progress?.done).toBe(3);
    expect(state.agentWorking?.since).toBe(since!);

    // Garbage counts are dropped, not trusted into the window.
    await post("/__lucid/ack", { id: "p-3", progress: { total: -4, done: Number.NaN } });
    state = foldLog((await readEvents(paths.logPath)).events);
    // No usable fields -> the ack carries no progress, so the prior one stands.
    expect(state.agentWorking?.progress?.done).toBe(3);
  });

  test("context usage posts to a sidecar and surfaces in /__lucid/state", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    // Nothing reported yet -> no ring.
    let state = await (await get("/__lucid/state")).json();
    expect(state).not.toHaveProperty("contextUsage");

    // A statusline-shaped report (raw tokens) is stored and echoed with a
    // derived pct + a stamped `at`, without ever entering the log.
    const before = (await readEvents(paths.logPath)).events.length;
    const ok = await post("/__lucid/context", { used: 142000, total: 200000 });
    expect(ok.status).toBe(200);
    state = await (await get("/__lucid/state")).json();
    expect(state.contextUsage.pct).toBe(71);
    expect(state.contextUsage.used).toBe(142000);
    expect(typeof state.contextUsage.at).toBe("string");
    expect((await readEvents(paths.logPath)).events.length).toBe(before);

    // A malformed report is rejected, and the last good value stands.
    const bad = await post("/__lucid/context", { used: -1 });
    expect(bad.status).toBe(400);
    state = await (await get("/__lucid/state")).json();
    expect(state.contextUsage.pct).toBe(71);
  });

  test("the attendant's model/effort surface in /__lucid/state for the inherited pickers", async () => {
    await startServer();
    await writeAttendantSidecar(paths, {
      harness: "claude-code",
      nextCursor: "evt_00001",
      at: "2026-07-16T10:00:00.000Z",
      model: "opus-4.8",
      effort: "high",
    });
    const state = await (await get("/__lucid/state")).json();
    expect(state.lastAttendant).toMatchObject({
      harness: "claude-code",
      model: "opus-4.8",
      effort: "high",
    });
  });

  test("structured question round-trips options and a rich answer", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    // A multiple-choice question - options must survive the handler (not be
    // stripped like the pre-fix ack/progress path).
    await post("/__lucid/question", {
      id: "q1",
      text: "Which store for the cutover?",
      options: [
        { label: "Postgres", description: "managed, boring" },
        { label: "SQLite", description: "embedded, WAL" },
      ],
    });
    let state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].options).toHaveLength(2);
    expect(state.questions[0].options[0].label).toBe("Postgres");

    // An options-only answer (no free text) that also pins an artifact region.
    const anchor = {
      kind: "element",
      fingerprint: "f",
      domPath: "h1",
      snippet: "<h1>Hello</h1>",
    };
    const ok = await post("/__lucid/answer", {
      id: "a1",
      questionId: "q1",
      text: "",
      options: ["Postgres"],
      anchor,
    });
    expect(ok.status).toBe(200);
    state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].answered).toBe(true);
    expect(state.questions[0].answerOptions).toEqual(["Postgres"]);
    expect(state.questions[0].answerAnchor.domPath).toBe("h1");
    expect(state.questions[0].answer).toBeUndefined(); // empty text is omitted

    // A truly empty answer (no text, options, anchor, or images) is rejected.
    const empty = await post("/__lucid/answer", { id: "a2", questionId: "q1", text: "" });
    expect(empty.status).toBe(400);
  });

  test("a grouped question round-trips, and its answer is re-validated server-side", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    const group = [
      {
        id: "store",
        question: "Which store?",
        choices: [
          { id: "pg", label: "Postgres" },
          { id: "lite", label: "SQLite" },
        ],
      },
      { id: "when", question: "When?", allowDefer: true },
    ];
    expect((await post("/__lucid/question", { id: "g1", group })).status).toBe(200);

    let state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].group).toHaveLength(2);
    // The legacy fields are projected from the group, so a consumer that knows
    // nothing about groups still reads a usable question.
    expect(state.questions[0].text).toBe("Which store? (+1 more)");

    // An answer that misses a question is rejected with the validator's issues,
    // exactly as the drawer's own submit gate would have refused it.
    const bad = await post("/__lucid/answer", {
      id: "a1",
      questionId: "g1",
      text: "",
      items: [{ id: "store", selected: [{ id: "pg", label: "Postgres" }] }],
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues.map((i: { code: string }) => i.code)).toEqual([
      "unanswered_question",
    ]);

    // A selection that names a choice the group never offered is rejected too.
    const ghost = await post("/__lucid/answer", {
      id: "a2",
      questionId: "g1",
      text: "",
      items: [
        { id: "store", selected: [{ id: "mongo", label: "Mongo" }] },
        { id: "when", defer: true },
      ],
    });
    expect(ghost.status).toBe(400);
    expect((await ghost.json()).issues[0].code).toBe("unknown_choice");

    const ok = await post("/__lucid/answer", {
      id: "a3",
      questionId: "g1",
      text: "",
      items: [
        { id: "store", selected: [{ id: "pg", label: "Postgres" }] },
        { id: "when", defer: true },
      ],
    });
    expect(ok.status).toBe(200);
    state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].answered).toBe(true);
    expect(state.questions[0].answerItems).toHaveLength(2);
    // The agent-visible combined summary (Trevor's ProviderQuestionAccept.answer).
    expect(state.questions[0].answer).toBe("Which store? -> Postgres; When? -> Deferred");
  });

  test("a malformed rich question is a 400 with the contract's issue list", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    // Six questions is one over the cap, and the last has no text.
    const tooMany = await post("/__lucid/question", {
      id: "g2",
      group: Array.from({ length: 6 }, (_, i) => ({
        id: `q${i}`,
        question: i === 5 ? "" : `Q${i}?`,
      })),
    });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).issues.map((i: { code: string }) => i.code)).toEqual([
      "too_many_questions",
      "empty_question",
    ]);

    // An empty group is rejected rather than appended as a blank question.
    const empty = await post("/__lucid/question", { id: "g3", group: [] });
    expect(empty.status).toBe(400);
    expect((await empty.json()).issues[0].code).toBe("no_questions");
    expect((await (await get("/__lucid/state")).json()).questions ?? []).toHaveLength(0);

    // Per-item answers to a question that never carried a group are refused:
    // structure with nothing to validate against is a client bug, not an answer.
    await post("/__lucid/question", { id: "plain", text: "Ship it?" });
    const stray = await post("/__lucid/answer", {
      id: "a1",
      questionId: "plain",
      text: "",
      items: [{ id: "plain", text: "yes" }],
    });
    expect(stray.status).toBe(400);
    expect((await stray.json()).issues[0].code).toBe("unknown_question");
  });

  test("a one-question group takes a legacy answer, and a grouped one drops legacy fields", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/question", {
      id: "g5",
      group: [
        {
          id: "store",
          question: "Which store?",
          choices: [
            { id: "pg", label: "Postgres" },
            { id: "lite", label: "SQLite" },
          ],
        },
      ],
    });
    // A client that only speaks the legacy wire answers the question it was
    // shown; the server projects it onto the group rather than refusing it.
    const ok = await post("/__lucid/answer", {
      id: "a1",
      questionId: "g5",
      text: "",
      options: ["Postgres"],
    });
    expect(ok.status).toBe(200);
    let state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].answerItems).toEqual([
      { id: "store", selected: [{ id: "pg", label: "Postgres" }] },
    ]);
    expect(state.questions[0].answer).toBe("Postgres");
    // The legacy fields are NOT stored beside the items - one answer, one source.
    expect(state.questions[0]).not.toHaveProperty("answerOptions");

    // Legacy content that contradicts the items is dropped, so the derived
    // summary can never disagree with what was stored.
    const again = await post("/__lucid/answer", {
      id: "a2",
      questionId: "g5",
      text: "Mongo",
      options: ["SQLite"],
      items: [{ id: "store", selected: [{ id: "pg", label: "Postgres" }] }],
    });
    expect(again.status).toBe(200);
    state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].answer).toBe("Postgres");
    expect(state.questions[0]).not.toHaveProperty("answerOptions");
  });

  test("a rich answer stays readable to a reader that knows only text/options", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/question", {
      id: "g6",
      group: [
        {
          id: "store",
          question: "Which store?",
          choices: [{ id: "pg", label: "Postgres" }],
        },
        { id: "when", question: "When?" },
      ],
    });
    // No `text` at all: a grouped answer's content is `items`, and demanding a
    // legacy field it does not use would refuse a valid answer.
    const ok = await post("/__lucid/answer", {
      id: "a1",
      questionId: "g6",
      items: [
        { id: "store", selected: [{ id: "pg", label: "Postgres" }] },
        { id: "when", text: "after the freeze" },
      ],
    });
    expect(ok.status).toBe(200);

    // The APPENDED event carries the legacy projection, so an older binary
    // reopening this log reads an answer instead of an answered-but-blank
    // question.
    const events = (await readEvents(paths.logPath)).events;
    const answered = events.find((e) => e.t === "question_answered");
    expect(answered && "text" in answered ? answered.text : undefined).toBe(
      "Which store? -> Postgres; When? -> after the freeze",
    );
  });

  test("a pinned region alone answers a single free-text question", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/question", {
      id: "g7",
      group: [{ id: "step", question: "Which step is wrong? Point at it." }],
    });
    // Pointing at the artifact says as much as typing: the anchor IS the answer.
    const ok = await post("/__lucid/answer", {
      id: "a1",
      questionId: "g7",
      items: [{ id: "step" }],
      anchor: { kind: "element", fingerprint: "f", domPath: "h1", snippet: "<h1>Backfill</h1>" },
    });
    expect(ok.status).toBe(200);
    const state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].answered).toBe(true);
    expect(state.questions[0].answerAnchor.domPath).toBe("h1");
  });

  test("a later answer replaces an earlier one instead of merging with it", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/question", { id: "q1", text: "Ship it?" });
    await post("/__lucid/answer", { id: "a1", questionId: "q1", text: "", skipped: true });
    await post("/__lucid/answer", { id: "a2", questionId: "q1", text: "yes, ship it" });
    const state = await (await get("/__lucid/state")).json();
    // The skip does not survive the real answer that followed it.
    expect(state.questions[0]).not.toHaveProperty("skipped");
    expect(state.questions[0].answer).toBe("yes, ship it");
  });

  test("a grouped question can still be skipped without answering any item", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/question", {
      id: "g4",
      group: [{ id: "q", question: "Which store?", choices: [{ id: "pg", label: "Postgres" }] }],
    });
    // Skip short-circuits validation: declining cannot be malformed.
    const ok = await post("/__lucid/answer", {
      id: "s1",
      questionId: "g4",
      text: "",
      skipped: true,
      items: [{ id: "nonsense" }],
    });
    expect(ok.status).toBe(200);
    const state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].skipped).toBe(true);
    expect(state.questions[0]).not.toHaveProperty("answerItems");
  });

  test("a question can be skipped: empty answer allowed, marked declined", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/question", { id: "q9", text: "Do you have the API keys?" });
    // Skip is an explicit empty answer - allowed where a bare one is rejected.
    const ok = await post("/__lucid/answer", {
      id: "s1",
      questionId: "q9",
      text: "",
      skipped: true,
    });
    expect(ok.status).toBe(200);
    const state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].answered).toBe(true);
    expect(state.questions[0].skipped).toBe(true);
    expect(state.questions[0].answer).toBeUndefined();
  });

  test("a question can be handed back as unclear: bare allowed, any note kept", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/question", { id: "q10", text: "A very long, tangled question" });
    // Re-ask carries no decision, so a bare one is allowed - and the note, when
    // there is one, is what the human found confusing.
    const ok = await post("/__lucid/answer", {
      id: "u1",
      questionId: "q10",
      text: "what does 'the gate' mean here?",
      unclear: true,
    });
    expect(ok.status).toBe(200);
    let state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].answered).toBe(true);
    expect(state.questions[0].unclear).toBe(true);
    expect(state.questions[0].skipped).toBeUndefined();
    expect(state.questions[0].answer).toBe("what does 'the gate' mean here?");

    // Last outcome wins, REPLACING the record rather than merging over it: a
    // later skip is a skip, not a skip-and-unclear chimera. (The fast
    // double-click race lives in the chrome, which guards it with an
    // in-flight set before a second event can be posted at all.)
    await post("/__lucid/answer", { id: "u2", questionId: "q10", text: "", skipped: true });
    state = await (await get("/__lucid/state")).json();
    expect(state.questions[0].skipped).toBe(true);
    expect(state.questions[0].unclear).toBeUndefined();
    expect(state.questions[0].answer).toBeUndefined();

    // A bare re-ask (no note at all) is allowed, and never carries a decision.
    await post("/__lucid/question", { id: "q11", text: "Another tangled question" });
    const bare = await post("/__lucid/answer", {
      id: "u3",
      questionId: "q11",
      text: "",
      unclear: true,
      options: ["Postgres"],
    });
    expect(bare.status).toBe(200);
    state = await (await get("/__lucid/state")).json();
    expect(state.questions[1].unclear).toBe(true);
    expect(state.questions[1].answer).toBeUndefined();
    expect(state.questions[1].answerOptions).toBeUndefined();
  });

  test("lucid context falls back to the sidecar when no daemon is live", async () => {
    // No server running: runContext must still land the value on disk (the same
    // path a failed live POST falls through to) so a reopened viewer picks it up.
    await ensureSessionDirs(paths);
    await runContext(paths.artifactPath, { pct: 88 });
    const usage = await readContextSidecar(paths);
    expect(usage?.pct).toBe(88);
    expect(typeof usage?.at).toBe("string");
  });

  test("state exposes the last attendant so the viewer can offer its resume command", async () => {
    await startServer();
    // Nothing has attended: the affordance has nothing to show, and says so by
    // omission rather than by inventing a command.
    expect(await (await get("/__lucid/state")).json()).not.toHaveProperty("lastAttendant");

    await writeAttendantSidecar(paths, {
      harness: "claude-code",
      nextCursor: "evt_00003",
      at: new Date().toISOString(),
      resume: "claude --resume s-1 --dangerously-skip-permissions",
    });
    const state = (await (await get("/__lucid/state")).json()) as {
      lastAttendant?: { harness: string; resume?: string };
    };
    expect(state.lastAttendant).toMatchObject({
      harness: "claude-code",
      resume: "claude --resume s-1 --dangerously-skip-permissions",
    });
  });

  test("agent question -> human answer reaches the agent as feedback", async () => {
    await startServer();
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
        body: JSON.stringify(body),
      });

    await post("/__lucid/question", { id: "q1", text: "Should backfill run first?", ref: "h" });

    // Before any answer, wait drains a version-only/no delta as waiting, but the
    // question is present in state.
    const state = await runWait(paths, { timeoutMs: 500 });
    expect(state.questions?.[0]?.text).toBe("Should backfill run first?");
    expect(state.questions?.[0]?.answered).toBe(false);

    await post("/__lucid/answer", { id: "ans1", questionId: "q1", text: "yes, first" });

    const fb = await runWait(paths, { since: "evt_00001", timeoutMs: 3000 });
    expect(fb.status).toBe("feedback");
    const q = fb.questions?.find((x) => x.id === "q1");
    expect(q?.answered).toBe(true);
    expect(q?.answer).toBe("yes, first");
  });

  test("revert posts a self-justifying decision that reaches the agent", async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/__lucid/revert`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({
        id: "rev-1",
        targetVersion: 1,
        why: "batching adds rollback risk",
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

    const payload = await runWait(paths, { since: "evt_00001", timeoutMs: 3000 });
    expect(payload.status).toBe("feedback");
    expect(payload.reverts?.[0]?.targetVersion).toBe(1);
    expect(payload.reverts?.[0]?.why).toBe("batching adds rollback risk");
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

  test("an annotation POST is delivered to an SSE subscriber as a data frame", async () => {
    await startServer();
    // Open the SSE stream and collect frames until we see the annotation.
    const res = await get("/__lucid/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    // Wait for the connected preamble, then POST an annotation.
    const decoder = new TextDecoder();
    let buf = "";
    const waitFor = async (needle: string, timeoutMs = 4000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader!.read();
        if (done) throw new Error("stream closed before frame");
        buf += decoder.decode(value, { stream: true });
        if (buf.includes(needle)) return;
      }
      throw new Error(`timed out waiting for ${needle}; got: ${buf}`);
    };
    await waitFor(": connected");

    await fetch(`http://127.0.0.1:${port}/__lucid/annotation`, {
      method: "POST",
      headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
      body: JSON.stringify({
        id: "sse-1",
        version: 1,
        note: "delivered over sse",
        target: {
          kind: "element",
          lucidId: "h",
          fingerprint: "x",
          domPath: "h1",
          snippet: "<h1>Hello</h1>",
        },
      }),
    });

    // The frame is a `data:` line whose JSON carries the annotation event.
    await waitFor('"t":"annotation"');
    expect(buf).toContain("delivered over sse");
    expect(buf).toContain("data: ");
    reader!.cancel().catch(() => {});
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
