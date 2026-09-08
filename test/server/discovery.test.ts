import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations } from "../../src/cli/record-addressing.js";
import { sendInput } from "../../src/cli/send.js";
import { startServe } from "../../src/cli/serve.js";
import { encodeAnnotationBatch } from "../../src/protocol/annotations.js";

import { createConversationHost, openWriter } from "../../src/store/conversation-host.js";
import { readRecordSummary, watchConversations } from "../../src/store/discovery.js";
import { writeDriverPreference } from "../../src/store/driver-preference.js";
import { createConversationRecord } from "../../src/store/store.js";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServe>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-discovery-"));
  roots.push(root);
  const server = await startServe({ port: 0, rootDir: root });
  servers.push(server);
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { "x-lucid-token": server.token, ...init.headers },
    });
  return { request, root };
};

test("a terminal-created record appears in the hub and opens by its saved identity", async () => {
  const { request, root } = await setup();
  conversations(root).ensure("terminal-conversation");
  const response = await request("/api/conversations");
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.conversations.map((item: { conversationId: string }) => item.conversationId)).toEqual(
    ["terminal-conversation"],
  );
  expect(page.nextCursor).toBeNull();
  expect((await request("/api/conversations/terminal-conversation")).status).toBe(200);
});

test("hub names follow the document when it arrives and when either view renames it", async () => {
  const { request, root } = await setup();
  const created = createConversationRecord(root, "document-name");
  sendInput("document-name", { rootDir: root, text: "you there?" });
  const row = async () => (await (await request("/api/conversations")).json()).conversations[0];
  expect(await row()).toMatchObject({ title: "you there" });
  const host = openWriter(created.paths.dir);
  try {
    host.writeArtifact({
      artifactId: "personal-agent-plan",
      author: "agent",
      bytes: "<h1>Your personal agent</h1>",
      contentType: "text/html",
      version: 1,
    });
    expect(await row()).toMatchObject({
      artifactId: "personal-agent-plan",
      title: "personal-agent-plan",
    });
    const before = readFileSync(created.paths.metaPath, "utf8");
    for (const title of ["Personal agent plan", "My daily assistant"]) {
      const response = await request(
        "/api/conversations/document-name/artifacts/personal-agent-plan/meta",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        },
      );
      expect(response.status).toBe(200);
      expect(await row()).toMatchObject({ title, artifactId: "personal-agent-plan" });
      const catalog = await (await request("/api/conversations/document-name/artifacts")).json();
      expect(catalog.artifacts[0]).toMatchObject({ title, versions: [1] });
    }
    expect(readFileSync(created.paths.metaPath, "utf8")).toBe(before);
  } finally {
    host.close();
  }
});

test("a renamed directory still opens and accepts input under its saved identity", async () => {
  const { request, root } = await setup();
  conversations(root).ensure("kept-identity");
  renameSync(join(root, "kept-identity"), join(root, "moved-directory"));
  expect(conversations(root).dirFor("kept-identity")).toBe(join(root, "moved-directory"));
  const page = await (await request("/api/conversations")).json();
  expect(page.conversations[0].conversationId).toBe("kept-identity");
  const detail = await (await request("/api/conversations/kept-identity")).json();
  expect(detail.conversationId).toBe("kept-identity");
  expect(detail.status).not.toBe("no record");
  const input = await request("/api/conversations/kept-identity/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "stay in this conversation" }),
  });
  expect(input.status).toBe(200);
  expect((await (await request("/api/conversations")).json()).conversations).toHaveLength(1);
});

test("ambiguous and missing identities never select a record or mint one through existing-record routes", async () => {
  const { request, root } = await setup();
  conversations(root).ensure("duplicate");
  cpSync(join(root, "duplicate"), join(root, "second-copy"), { recursive: true });
  expect(() => conversations(root).dirFor("duplicate")).toThrow("ambiguous");
  expect(() => conversations(root).ensure("duplicate")).toThrow("ambiguous");
  const page = await (await request("/api/conversations")).json();
  expect(page.conversations).toEqual([]);
  expect(page.errors[0]).toMatchObject({ code: "E-HUB-01", conversationId: "duplicate" });
  for (const [id, status] of [
    ["duplicate", 409],
    ["missing", 404],
  ] as const) {
    expect((await request(`/api/conversations/${id}`)).status).toBe(status);
    for (const route of ["input", "driver", "attachments"]) {
      const response = await request(`/api/conversations/${id}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(status);
    }
  }
  expect(readdirSync(root).sort()).toEqual(["duplicate", "second-copy"]);
});

test("creation groups subfolders, nested repositories, worktrees and ordinary folders while preserving cwd", async () => {
  const { request, root } = await setup();
  const workspace = mkdtempSync(join(tmpdir(), "lucid-projects-"));
  roots.push(workspace);
  const repo = join(workspace, "repo");
  const sub = join(repo, "sub");
  const nested = join(sub, "nested");
  const plain = join(workspace, "plain");
  for (const dir of [sub, nested, plain]) mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  execFileSync("git", ["init", "-q", nested]);
  const worktree = join(workspace, "worktree");
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktree], { stdio: "ignore" });
  const alias = join(workspace, "alias");
  symlinkSync(sub, alias);
  const cases = [
    ["sub", alias, repo],
    ["nested", nested, nested],
    ["worktree", worktree, worktree],
    ["plain", plain, plain],
  ] as const;
  for (const [id, cwd, project] of cases) {
    conversations(root).ensure(id, { workingDirectory: cwd });
    const item = (await (await request("/api/conversations")).json()).conversations.find(
      (value: { conversationId: string }) => value.conversationId === id,
    );
    expect(item).toMatchObject({
      projectDirectory: realpathSync(project),
      workingDirectory: realpathSync(cwd),
      workingDirectoryStatus: "available",
    });
  }
});

test("legacy discovery derives a short title without changing metadata or starting a driver", async () => {
  const { request, root } = await setup();
  const created = createConversationRecord(root, "legacy");
  sendInput("legacy", {
    rootDir: root,
    text: "Investigate the missing conversation in our hub today",
  });
  const meta = readFileSync(created.paths.metaPath, "utf8");
  const log = readFileSync(created.paths.logPath, "utf8");
  const files = readdirSync(created.paths.dir).sort();
  const page = await (await request("/api/conversations")).json();
  expect(page.conversations[0]).toMatchObject({
    conversationId: "legacy",
    projectDirectory: null,
    workingDirectory: null,
    workingDirectoryStatus: "unknown",
    title: "Investigate the missing conversation in our hub",
  });
  expect(readFileSync(created.paths.metaPath, "utf8")).toBe(meta);
  expect(readFileSync(created.paths.logPath, "utf8")).toBe(log);
  expect(readdirSync(created.paths.dir).sort()).toEqual(files);
  expect(JSON.stringify(page)).not.toContain(created.secret);
});

test("staging and damaged records do not hide valid records, and a root failure is not empty history", async () => {
  const { request, root } = await setup();
  createConversationRecord(root, "healthy");
  cpSync(join(root, "healthy"), join(root, ".create-orphan"), { recursive: true });
  mkdirSync(join(root, "broken"));
  writeFileSync(join(root, "broken", "meta.json"), "{");
  createConversationRecord(root, "bad-log");
  writeFileSync(join(root, "bad-log", "log.ndjson"), "not-json\n");
  const response = await request("/api/conversations");
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(
    page.conversations.some(
      (item: { conversationId: string }) => item.conversationId === "healthy",
    ),
  ).toBe(true);
  expect(page.errors).toHaveLength(2);
  expect(page.errors.every((item: { code: string }) => item.code === "E-HUB-01")).toBe(true);
  rmSync(root, { recursive: true, force: true });
  writeFileSync(root, "not a directory");
  const unavailable = await request("/api/conversations");
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({ code: "E-HUB-01", error: "root-unavailable" });
});

test("discovery pages use a stable identity cursor and never duplicate records after changes", async () => {
  const { request, root } = await setup();
  for (const id of ["charlie", "alpha", "bravo"]) createConversationRecord(root, id);
  const first = await (await request("/api/conversations?limit=2")).json();
  expect(
    first.conversations.map((item: { conversationId: string }) => item.conversationId),
  ).toEqual(["alpha", "bravo"]);
  expect(typeof first.nextCursor).toBe("string");
  createConversationRecord(root, "beta");
  const next = await (
    await request(`/api/conversations?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
  ).json();
  expect(next.conversations.map((item: { conversationId: string }) => item.conversationId)).toEqual(
    ["charlie"],
  );
  expect(next.nextCursor).toBeNull();
  expect((await request("/api/conversations?limit=0")).status).toBe(400);
  expect((await request("/api/conversations?cursor=invalid")).status).toBe(400);
  const fresh = await (await request("/api/conversations")).json();
  expect(fresh.conversations).toHaveLength(4);
});

test("server discovery reconciles missed hints within five seconds without a browser", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-reconciliation-"));
  roots.push(root);
  let tick = () => {};
  let hint = () => {};
  let interval = 0;
  let stopped = 0;
  const monitor = watchConversations(root, {
    repeat: (callback, milliseconds) => {
      tick = callback;
      interval = milliseconds;
      return () => {
        stopped++;
      };
    },
    observe: (_root, callback) => {
      hint = callback;
      return () => {
        stopped++;
      };
    },
  });
  expect(monitor.current()).toMatchObject({ records: [] });
  createConversationRecord(root, "missed-hint");
  expect(monitor.current()).toMatchObject({ records: [] });
  expect(interval).toBeGreaterThan(0);
  expect(interval).toBeLessThanOrEqual(5000);
  tick();
  expect(monitor.current()).toMatchObject({ records: [{ conversationId: "missed-hint" }] });
  createConversationRecord(root, "hinted");
  hint();
  expect(monitor.current()).toMatchObject({
    records: expect.arrayContaining([{ ...readRecordSummary(join(root, "hinted")) }]),
  });
  monitor.close();
  expect(stopped).toBe(2);
});

test("a writer refuses a changed identity after acquiring the append lock", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-identity-lock-"));
  roots.push(root);
  const created = createConversationRecord(root, "original");
  let changeIdentity = false;
  const host = createConversationHost(created.paths.dir, {
    now: () => 1,
    presence: () => undefined,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
    onLockEvent: (event) => {
      if (changeIdentity && event.event === "lock.acquire")
        writeFileSync(
          created.paths.metaPath,
          JSON.stringify({ v: 1, conversationId: "replacement" }),
        );
    },
  });
  changeIdentity = true;
  expect(() =>
    host.enqueueInput({ id: "must-not-append", text: "wrong record", mode: "queue" }),
  ).toThrow();
  expect(readFileSync(created.paths.logPath, "utf8")).toBe("");
  host.close();
});

test("terminal send refuses an unknown conversation without creating it", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-send-missing-"));
  roots.push(root);
  expect(() => sendInput("missing", { rootDir: root, text: "resume this conversation" })).toThrow();
  expect(readdirSync(root)).toEqual([]);
});

test("identity refusal also prevents attachment files and preference replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-identity-files-"));
  roots.push(root);
  const created = createConversationRecord(root, "original");
  const host = openWriter(created.paths.dir, { expectedConversationId: "original" });
  writeFileSync(created.paths.metaPath, JSON.stringify({ v: 1, conversationId: "replacement" }));
  const before = readdirSync(created.paths.dir).sort();
  expect(() =>
    host.writeAttachment({
      bytes: new TextEncoder().encode("must not persist"),
      contentType: "text/plain",
      name: "note.txt",
      text: true,
    }),
  ).toThrow();
  expect(readdirSync(created.paths.dir).sort()).toEqual(before);
  expect(() =>
    writeDriverPreference(created.paths.dir, { harness: "claude" }, "original"),
  ).toThrow();
  expect(readdirSync(created.paths.dir).sort()).toEqual(before);
  host.close();
});

test("a damaged duplicate still conflicts, while invalid optional folder metadata keeps the identity readable", async () => {
  const { request, root } = await setup();
  conversations(root).ensure("duplicate-damaged");
  cpSync(join(root, "duplicate-damaged"), join(root, "damaged-copy"), { recursive: true });
  rmSync(join(root, "damaged-copy", "log.ndjson"));
  expect((await request("/api/conversations/duplicate-damaged")).status).toBe(409);
  const valid = createConversationRecord(root, "invalid-folder");
  writeFileSync(
    valid.paths.metaPath,
    JSON.stringify({ v: 1, conversationId: "invalid-folder", workingDirectory: "relative" }),
  );
  expect((await request("/api/conversations/invalid-folder")).status).toBe(200);
  const listing = await (await request("/api/conversations")).json();
  expect(listing.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ conversationId: "invalid-folder" })]),
  );
  expect(listing.conversations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ conversationId: "invalid-folder", workingDirectory: null }),
    ]),
  );
});

test("closing discovery prevents late hints from restarting its watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-watch-close-"));
  roots.push(root);
  let hint = () => {};
  let watches = 0;
  const monitor = watchConversations(root, {
    repeat: () => () => {},
    observe: (_root, callback) => {
      watches++;
      hint = callback;
      return () => {};
    },
  });
  monitor.close();
  hint();
  expect(watches).toBe(1);
});

test("discovery errors never consume the conversation page budget", async () => {
  const { request, root } = await setup();
  for (let i = 0; i < 4; i++) {
    mkdirSync(join(root, `broken-${i}`));
    writeFileSync(join(root, `broken-${i}`, "meta.json"), "{");
  }
  createConversationRecord(root, "readable");
  const page = await (await request("/api/conversations?limit=1")).json();
  expect(page.conversations).toEqual([expect.objectContaining({ conversationId: "readable" })]);
  expect(page.errors).toHaveLength(4);
  expect(page.nextCursor).toBeNull();
});

test("annotation-first records use readable feedback instead of encoded JSON for the title", async () => {
  const { request, root } = await setup();
  createConversationRecord(root, "annotation-first");
  sendInput("annotation-first", {
    rootDir: root,
    text: encodeAnnotationBatch({
      artifactId: "document",
      version: 1,
      notes: [{ note: "Explain the missing verification step", spots: [] }],
    }),
  });
  const page = await (await request("/api/conversations")).json();
  expect(page.conversations[0].title).toBe("Explain the missing verification step");
});

test("a folder with unusable Git metadata can still create a conversation", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-invalid-git-"));
  roots.push(root);
  const folder = join(root, "workspace", "subfolder");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(root, "workspace", ".git"), "not a Git directory pointer");
  const created = conversations(join(root, "records")).ensure("folder-only", {
    workingDirectory: folder,
  });
  expect(JSON.parse(readFileSync(join(created.dir, "meta.json"), "utf8"))).toMatchObject({
    workingDirectory: realpathSync(folder),
    projectDirectory: realpathSync(folder),
  });
});

test("same folder names stay separate and a missing working folder preserves its project", async () => {
  const { request, root } = await setup();
  const workspace = mkdtempSync(join(tmpdir(), "lucid-project-names-"));
  roots.push(workspace);
  const left = join(workspace, "left", "project");
  const right = join(workspace, "right", "project");
  mkdirSync(left, { recursive: true });
  mkdirSync(right, { recursive: true });
  conversations(root).ensure("left", { workingDirectory: left });
  conversations(root).ensure("right", { workingDirectory: right });
  const expectedLeft = realpathSync(left);
  const expectedRight = realpathSync(right);
  rmSync(left, { recursive: true });
  const page = await (await request("/api/conversations")).json();
  expect(page.conversations).toEqual([
    expect.objectContaining({
      conversationId: "left",
      projectDirectory: expectedLeft,
      workingDirectory: expectedLeft,
      workingDirectoryStatus: "missing",
    }),
    expect.objectContaining({
      conversationId: "right",
      projectDirectory: expectedRight,
      workingDirectoryStatus: "available",
    }),
  ]);
});

test("typed text takes priority over an accompanying annotation when naming a record", async () => {
  const { request, root } = await setup();
  createConversationRecord(root, "typed-feedback");
  sendInput("typed-feedback", {
    rootDir: root,
    text: encodeAnnotationBatch(
      { artifactId: "document", version: 1, notes: [{ note: "Explain this step", spots: [] }] },
      "Revise onboarding before launch",
    ),
  });
  const page = await (await request("/api/conversations")).json();
  expect(page.conversations[0].title).toBe("Revise onboarding before launch");
});
