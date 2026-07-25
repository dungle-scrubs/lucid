import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ForkRecord } from "../src/core/fold.ts";
import { appendEvent } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { ensureSessionDirs, openSession } from "../src/core/session.ts";
import type { WaitPayload } from "../src/protocol/wire.ts";
import { childArtifactPath, handleForks, revisePrompt } from "../src/launch/launcher.ts";
import { buildArgv, loadRegistry, resolveRecipe } from "../src/launch/recipes.ts";
import { forkDirFor, writeForkSeed } from "../src/launch/seed.ts";
import { discoverLiveServer, readServerDescriptor } from "../src/server/discovery.ts";
import { runServer } from "../src/server/server.ts";

const STUB = resolve(import.meta.dir, "launch-stub.ts");
const DOC =
  '<!doctype html><html><head><title>t</title></head><body><h1 data-lucid-id="h">Hello</h1></body></html>';

const elementTarget = (snippet: string) => ({
  kind: "element" as const,
  lucidId: "h",
  fingerprint: "f",
  domPath: "h1",
  snippet,
});

describe("revisePrompt locations", () => {
  const base: WaitPayload = {
    session: "/tmp/plan.html",
    version: 1,
    status: "feedback",
    nextCursor: "evt_00009",
    reviewResolved: false,
    annotations: [],
    messages: [],
  };
  const spot = (text: string) => ({
    kind: "element" as const,
    fingerprint: "f",
    domPath: "p",
    snippet: text,
  });

  test("a multi-target annotation lists every location, each clipped to 100 chars", () => {
    const long = `<li>${"x".repeat(200)}</li>`;
    const payload: WaitPayload = {
      ...base,
      annotations: [
        {
          id: "a1",
          version: 1,
          resolved: true,
          target: spot("<li>alpha</li>"),
          targets: [spot("<li>alpha</li>"), spot("<li>beta</li>"), spot(long)],
          note: "align these",
          at: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const prompt = revisePrompt(payload, "/tmp/plan.html");
    expect(prompt).toContain(
      `- align these (at: <li>alpha</li>; <li>beta</li>; ${long.slice(0, 100)})`,
    );
    expect(prompt).not.toContain("x".repeat(101));
  });

  test("an answer with pinned regions appends each snippet; a pin alone still surfaces", () => {
    const payload: WaitPayload = {
      ...base,
      questions: [
        {
          id: "q1",
          text: "Which sections?",
          answered: true,
          answer: "these",
          answerAnchor: spot("<h2>Intro</h2>"),
          answerAnchors: [spot("<h2>Intro</h2>"), spot("<h2>Rollout</h2>")],
        },
        {
          id: "q2",
          text: "And where does the note go?",
          answered: true,
          answerAnchor: spot("<h2>Risks</h2>"),
        },
      ],
    };
    const prompt = revisePrompt(payload, "/tmp/plan.html");
    expect(prompt).toContain(
      '- answer to "Which sections?": these (pinned: <h2>Intro</h2>; <h2>Rollout</h2>)',
    );
    // A pin with no words is still a whole answer, not a dropped line.
    expect(prompt).toContain('- answer to "And where does the note go?": (pinned: <h2>Risks</h2>)');
  });
});

describe("recipes registry", () => {
  let dir: string;
  let regPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-reg-"));
    regPath = join(dir, "harnesses.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("absent file means the launcher is off (null, no throw)", async () => {
    expect(await loadRegistry(join(dir, "nope.json"))).toBeNull();
  });

  test("loads, resolves by name and default, and substitutes argv", async () => {
    await writeFile(
      regPath,
      JSON.stringify({
        default: "claude_code",
        harnesses: {
          claude_code: { spawn: ["claude", "-p", "--session-id", "{id}", "{prompt}"] },
        },
      }),
    );
    const reg = await loadRegistry(regPath);
    expect(reg).not.toBeNull();
    if (!reg) return;
    // Unknown harness falls back to default.
    expect(resolveRecipe(reg, "unlisted")?.name).toBe("claude_code");
    const resolved = resolveRecipe(reg, "claude_code");
    expect(resolved?.name).toBe("claude_code");
    const argv = buildArgv(resolved?.recipe.spawn ?? [], { id: "abc", prompt: "do it" });
    expect(argv).toEqual(["claude", "-p", "--session-id", "abc", "do it"]);
  });

  test("a malformed registry throws rather than silently disabling", async () => {
    await writeFile(regPath, JSON.stringify({ harnesses: { bad: { spawn: [] } } }));
    await expect(loadRegistry(regPath)).rejects.toThrow(/non-empty/);
  });

  test("a default that names no harness is rejected", async () => {
    await writeFile(
      regPath,
      JSON.stringify({ default: "ghost", harnesses: { real: { spawn: ["x"] } } }),
    );
    await expect(loadRegistry(regPath)).rejects.toThrow(/default/);
  });
});

describe("safe fork ids", () => {
  test("strips path-traversal characters so a fork dir stays under the session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucid-safe-"));
    try {
      const paths = sessionPaths(join(dir, "plan.html"));
      const evil = forkDirFor(paths, "../../../../etc/passwd");
      // The result must remain inside the session's forks/ directory.
      expect(evil.startsWith(join(paths.sessionDir, "forks"))).toBe(true);
      expect(evil).not.toContain("..");
      // Distinct full ids do not collide (no 8-char truncation).
      const a = childArtifactPath(paths, "11111111-aaaa");
      const b = childArtifactPath(paths, "11111111-bbbb");
      expect(a).not.toBe(b);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fork seed", () => {
  let dir: string;
  let paths: SessionPaths;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-seed-"));
    paths = sessionPaths(join(dir, "plan.html"));
    ensureSessionDirs(paths);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("materializes directive, source, and region into markdown", async () => {
    const fork: ForkRecord = {
      id: "fk1",
      seq: 2,
      version: 1,
      target: elementTarget("Backfill from the archive"),
      note: "turn this into an implementation plan",
      at: "2026-01-01T00:00:00Z",
    };
    const { seedPath } = await writeForkSeed(paths, fork);
    const body = await readFile(seedPath, "utf8");
    expect(body).toContain("turn this into an implementation plan");
    expect(body).toContain("plan.html (v1)");
    expect(body).toContain("> Backfill from the archive");
  });
});

describe("launcher handleForks (integration, stub harness)", () => {
  let dir: string;
  let parent: SessionPaths;
  let regPath: string;
  const childServers: { paths: SessionPaths; done: Promise<void> }[] = [];
  const savedEnv = { harnesses: process.env.LUCID_HARNESSES, noOpen: process.env.LUCID_NO_OPEN };

  // In-process opener: `bun test` cannot spawn a detached CLI (self-invocation
  // points at the test runner), so stand a real server up in-process instead -
  // the same seam server.test.ts uses.
  const openChild = async (cp: SessionPaths): Promise<boolean> => {
    await openSession(cp);
    childServers.push({ paths: cp, done: runServer(cp, [0], { idleMs: 0 }) });
    for (let i = 0; i < 200; i++) {
      if (await readServerDescriptor(cp)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-launch-"));
    parent = sessionPaths(join(dir, "review.html"));
    await writeFile(parent.artifactPath, DOC);
    ensureSessionDirs(parent);
    await openSession(parent);
    regPath = join(dir, "harnesses.json");
    // A stub recipe: the real bun binary runs the test stub, no resume (one-shot).
    await writeFile(
      regPath,
      JSON.stringify({
        default: "stub",
        harnesses: { stub: { spawn: [process.execPath, STUB, "{seed}", "{artifact}"] } },
      }),
    );
    process.env.LUCID_HARNESSES = regPath;
    process.env.LUCID_NO_OPEN = "1";
  });

  afterEach(async () => {
    for (const s of childServers) {
      const d = await discoverLiveServer(s.paths);
      if (d)
        await fetch(`http://127.0.0.1:${d.port}/__lucid/end`, {
          method: "POST",
          headers: { host: `127.0.0.1:${d.port}` },
        }).catch(() => {});
      await s.done.catch(() => {});
    }
    childServers.length = 0;
    process.env.LUCID_HARNESSES = savedEnv.harnesses;
    process.env.LUCID_NO_OPEN = savedEnv.noOpen;
    await rm(dir, { recursive: true, force: true });
  });

  test("a fork event spawns the recipe, authors the child, and opens it", async () => {
    await appendEvent(parent.logPath, {
      t: "fork",
      id: "fork-1",
      version: 1,
      target: elementTarget("Hello"),
      note: "spin off a plan for the greeting",
    });
    const registry = await loadRegistry(regPath);
    expect(registry).not.toBeNull();
    if (!registry) return;

    const created = await handleForks(parent, registry, {
      openBrowser: false,
      openChild,
      log: () => {},
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe("created");

    const childPaths = sessionPaths(created[0]?.childArtifact ?? "");
    // The stub authored the child artifact from the seed directive.
    expect(await readFile(childPaths.artifactPath, "utf8")).toContain("greeting");
    // The launcher ensured a live viewer for it.
    expect(await discoverLiveServer(childPaths)).toBeTruthy();

    // Idempotent: a second pass creates nothing (fork already handled).
    const again = await handleForks(parent, registry, {
      openBrowser: false,
      openChild,
      log: () => {},
    });
    expect(again).toHaveLength(0);
  });

  test("a corrupt handled.json throws rather than silently re-spawning every fork", async () => {
    await appendEvent(parent.logPath, {
      t: "fork",
      id: "fork-2",
      version: 1,
      target: elementTarget("Hello"),
      note: "spin off",
    });
    const forksDir = join(parent.sessionDir, "forks");
    await import("node:fs/promises").then((fs) => fs.mkdir(forksDir, { recursive: true }));
    await writeFile(join(forksDir, "handled.json"), "{ not valid json");
    const registry = await loadRegistry(regPath);
    if (!registry) return;
    await expect(
      handleForks(parent, registry, { openBrowser: false, openChild, log: () => {} }),
    ).rejects.toThrow();
  });
});
