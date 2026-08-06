import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { readLastAttendant } from "../src/core/attendant.ts";
import { foldLog, type ForkRecord } from "../src/core/fold.ts";
import { appendEvent, readEvents, sessionState } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { readRegistry } from "../src/core/registry.ts";
import { assertRecordAvailable, ensureSessionDirs, openSession } from "../src/core/session.ts";
import { planTurn, runTurn } from "../src/launch/turn.ts";
import type { WaitPayload } from "../src/protocol/wire.ts";
import {
  attendChild,
  attendedByAnother,
  childArtifactPath,
  ensureChildOpen,
  handleForks,
} from "../src/launch/fork-launcher.ts";
import { createArtifactPrompt, createPrompt, revisePrompt } from "../src/launch/prompts.ts";
import {
  buildArgv,
  defaultRecipe,
  loadRegistry,
  requireSessionIdentity,
  resolveExactRecipe,
  resolveRecipe,
  type SpawnRecipe,
} from "../src/launch/recipes.ts";
import type { SessionIdentityRecipe } from "../src/launch/session-identity.ts";
import { forkDirFor, writeForkSeed } from "../src/launch/seed.ts";
import {
  discoverLiveServer,
  readServerDescriptor,
  writeServerDescriptor,
} from "../src/server/discovery.ts";
import { runServer } from "../src/server/server.ts";
import { applyUnitEnv } from "./unit-env.ts";

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

describe("revisePrompt tells the turn to declare its intent (finding #18)", () => {
  const payload = {
    status: "feedback",
    annotations: [],
    messages: [{ role: "human", text: "tighten the second paragraph" }],
    nextCursor: "evt_00001",
  } as never;

  test("the prompt names `lucid intent`, because it is the ONLY text a driven turn reads", () => {
    // The skill's instruction cannot reach a hub- or launcher-driven turn: its
    // whole instruction is this prompt. Without the line here, dropping the
    // spawners' speculative "revise" leaves the update-on-the-way marker dead
    // in production - and no test could notice, because every test that
    // asserts the marker injects the intent itself.
    const prompt = revisePrompt(payload, "/tmp/plan.html");
    expect(prompt).toContain("lucid intent");
    expect(prompt).toContain("/tmp/plan.html");
  });

  test("the prompt names `lucid progress --label`, the turn's only channel for subphases", () => {
    // Same delivery constraint as the intent line: a headless turn reads
    // nothing but this prompt, so the phase one-liners the viewer renders
    // under "Updating the artifact…" exist only if the instruction is here.
    const prompt = revisePrompt(payload, "/tmp/plan.html");
    expect(prompt).toContain("lucid progress /tmp/plan.html --label");
  });

  test("command lines in the prompt survive a path with spaces", () => {
    // The agent pastes these into a shell; an unquoted space splits the path
    // into two arguments and every narration/intent call targets a file that
    // does not exist.
    const prompt = revisePrompt(payload, "/tmp/My Plan.html");
    expect(prompt).toContain("lucid intent '/tmp/My Plan.html' revise");
    expect(prompt).toContain("lucid progress '/tmp/My Plan.html' --label");
  });
});

describe("the prompt protocol is one wording across every builder", () => {
  const artifact = "/tmp/My Plan.html";
  const payload = {
    status: "feedback",
    annotations: [],
    messages: [{ role: "human", text: "tighten the second paragraph" }],
    nextCursor: "evt_00001",
  } as never;

  test("an authoring turn is told to open the artifact, and to write only it", () => {
    // Three builders, one protocol. A clause that drifts in one of them tells
    // a fork-launcher turn something a hub turn is never told, and nothing
    // notices until an artifact is authored and never put in front of anyone.
    const open = "Then open it for review by running:\n  lucid open '/tmp/My Plan.html'";
    const only = "Write only /tmp/My Plan.html; do not modify other files.";
    for (const prompt of [
      createPrompt("/tmp/seed.json", artifact),
      createArtifactPrompt(artifact, "a plan for the migration"),
    ]) {
      expect(prompt).toContain(open);
      expect(prompt).toContain(only);
    }
  });

  test("a driven turn narrates its phases through the same command", () => {
    // The examples differ per builder (authoring and revising are different
    // work); the instruction and the command must not.
    const narration =
      "As you work, report each phase as you enter it: `lucid progress '/tmp/My Plan.html' --label \"<what you are doing, in a few words>\"` - for example ";
    const tail = ". The human watches these one-liners while they wait.";
    for (const prompt of [
      createArtifactPrompt(artifact, "a plan for the migration"),
      revisePrompt(payload, artifact),
    ]) {
      expect(prompt).toContain(narration);
      expect(prompt).toContain(tail);
    }
  });
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
    // The snippet is outerHTML; what the human pointed at is its VISIBLE text
    // (#12). Handing the markup over clipped at 100 chars gave the agent a tag
    // cut mid-attribute and no words - the failure the chrome already fixed for
    // the human and this surface never got.
    expect(prompt).toContain(`- align these (at: alpha; beta; ${"x".repeat(100)})`);
    expect(prompt).not.toContain("<li>");
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
    expect(prompt).toContain('- answer to "Which sections?": these (pinned: Intro; Rollout)');
    // A pin with no words is still a whole answer, not a dropped line.
    expect(prompt).toContain('- answer to "And where does the note go?": (pinned: Risks)');
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
    // The SAME harness spelled the other way resolves to the same recipe.
    // Artifacts are stamped `claude-code` while registries are commonly keyed
    // `claude_code`, and treating those as different harnesses made every
    // recorded session unresumable ("not in the registry") on such a machine.
    expect(resolveRecipe(reg, "claude-code")?.name).toBe("claude_code");
    expect(resolveRecipe(reg, "Claude-Code")?.name).toBe("claude_code");
    const argv = buildArgv(resolved?.recipe.spawn ?? [], { id: "abc", prompt: "do it" });
    expect(argv).toEqual(["claude", "-p", "--session-id", "abc", "do it"]);
  });

  test("an exact resolve answers the harness asked for or nothing at all", async () => {
    await writeFile(
      regPath,
      JSON.stringify({
        default: "claude_code",
        harnesses: {
          claude_code: { spawn: ["claude", "-p", "{prompt}"] },
          codex: { spawn: ["codex", "exec", "{prompt}"] },
        },
      }),
    );
    const reg = await loadRegistry(regPath);
    expect(reg).not.toBeNull();
    if (!reg) return;
    // The whole point: a harness this registry does not list is unanswerable,
    // never quietly the default. Spawning or resuming under a DIFFERENT agent
    // appends to the wrong transcript.
    expect(resolveExactRecipe(reg, "unlisted")).toBeUndefined();
    expect(resolveRecipe(reg, "unlisted")?.name).toBe("claude_code");
    expect(resolveExactRecipe(reg, "codex")?.name).toBe("codex");
    // Spelling is not identity: `claude-code` on an artifact IS `claude_code`
    // in the registry, so exactness does not mean byte-equal.
    expect(resolveExactRecipe(reg, "claude-code")?.name).toBe("claude_code");
    expect(resolveExactRecipe(reg, "Claude-Code")?.name).toBe("claude_code");
    // Having no harness to name is a different question, asked separately, so
    // that no unlisted harness can arrive at the default by falling through.
    expect(defaultRecipe(reg)?.name).toBe("claude_code");
    // An inherited key is not a harness here either.
    expect(resolveExactRecipe(reg, "constructor")).toBeUndefined();
  });

  test("`tools` is an editable grant the argv references, never a silent empty one", async () => {
    await writeFile(
      regPath,
      JSON.stringify({
        default: "claude_code",
        harnesses: {
          claude_code: {
            spawn: ["claude", "-p", "{prompt}", "--allowedTools", "{tools}"],
            resume: ["claude", "--resume", "{id}", "-p", "{prompt}", "--allowedTools", "{tools}"],
            tools: ["Bash(lucid *)", "Write", "Edit", "Read", "WebFetch"],
          },
        },
      }),
    );
    const reg = await loadRegistry(regPath);
    const recipe = reg && resolveRecipe(reg, "claude_code")?.recipe;
    expect(recipe?.tools).toEqual(["Bash(lucid *)", "Write", "Edit", "Read", "WebFetch"]);
    // One argv token, space-joined in declared order - the shape the CLI's own
    // allowlist flag takes. Which flag it is stays the recipe's business.
    expect(buildArgv(recipe?.spawn ?? [], { prompt: "go" }, recipe?.tools)).toEqual([
      "claude",
      "-p",
      "go",
      "--allowedTools",
      "Bash(lucid *) Write Edit Read WebFetch",
    ]);
    // The same grant covers a revise turn: a turn allowed to write on creation
    // and not on revision is a grant nobody meant to make.
    expect(buildArgv(recipe?.resume ?? [], { id: "s1", prompt: "again" }, recipe?.tools)).toContain(
      "Bash(lucid *) Write Edit Read WebFetch",
    );
  });

  test("{tools} with nothing behind it is refused, not substituted empty", async () => {
    // `--allowedTools ""` is a turn granted nothing: it fails on its first tool
    // call with nothing to read. Refused at load, while the file is on screen.
    await writeFile(
      regPath,
      JSON.stringify({
        harnesses: { claude_code: { spawn: ["claude", "--allowedTools", "{tools}"] } },
      }),
    );
    await expect(loadRegistry(regPath)).rejects.toThrow(/uses \{tools\}/);

    // And again at the point a caller could reintroduce it by forgetting.
    expect(() => buildArgv(["claude", "--allowedTools", "{tools}"], {})).toThrow(/\{tools\}/);
  });

  test("an empty or non-string `tools` list is rejected", async () => {
    await writeFile(
      regPath,
      JSON.stringify({ harnesses: { claude_code: { spawn: ["claude"], tools: [] } } }),
    );
    await expect(loadRegistry(regPath)).rejects.toThrow(/tools/);
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

  const writeHarnesses = (harnesses: Record<string, unknown>) =>
    writeFile(regPath, JSON.stringify({ harnesses }));

  test("caller-assigned identity requires an adjacent argument and id token", async () => {
    const valid = {
      resume: ["claude", "--resume", "x", "--session-id", "{id}", "-p", "{prompt}"],
      sessionIdentity: { argument: "--session-id", source: "caller-assigned" },
      spawn: ["claude", "--session-id", "{id}", "-p", "{prompt}"],
    } satisfies { resume: string[]; sessionIdentity: SessionIdentityRecipe; spawn: string[] };
    await writeHarnesses({ claude_code: valid });
    const registry = await loadRegistry(regPath);
    const resolved = registry && resolveRecipe(registry, "claude_code");
    expect(resolved?.recipe.sessionIdentity).toEqual(valid.sessionIdentity);
    expect(requireSessionIdentity(resolved?.name ?? "", resolved?.recipe, regPath)).toEqual(
      valid.sessionIdentity,
    );

    for (const malformed of [
      { ...valid, spawn: ["claude", "--session-id=x", "{id}"] },
      { ...valid, spawn: ["claude", "{id}", "--session-id"] },
      { ...valid, resume: ["claude", "--resume", "{id}"] },
    ]) {
      await writeHarnesses({ claude_code: malformed });
      await expect(loadRegistry(regPath)).rejects.toMatchObject({ code: "HSI001" });
    }
  });

  test("a harness that assigns and resumes with DIFFERENT flags declares both", async () => {
    // Claude assigns with `--session-id <id>` and re-enters with `--resume
    // <id>`. Demanding one spelling for both refused a correct recipe - found
    // by migrating the real managed registry.
    const valid = {
      resume: ["claude", "--resume", "{id}", "-p", "{prompt}"],
      sessionIdentity: {
        argument: "--session-id",
        resumeArgument: "--resume",
        source: "caller-assigned",
      },
      spawn: ["claude", "-p", "--session-id", "{id}", "{prompt}"],
    } satisfies { resume: string[]; sessionIdentity: SessionIdentityRecipe; spawn: string[] };
    await writeHarnesses({ claude_code: valid });
    const registry = await loadRegistry(regPath);
    expect(registry && resolveRecipe(registry, "claude_code")?.recipe.sessionIdentity).toEqual(
      valid.sessionIdentity,
    );

    // The resume flag is held to the same adjacency rule as the assign flag.
    await writeHarnesses({
      claude_code: { ...valid, resume: ["claude", "--resume", "x", "{id}", "-p", "{prompt}"] },
    });
    await expect(loadRegistry(regPath)).rejects.toMatchObject({ code: "HSI001" });
  });

  test("stdout JSONL identity validates bounded selectors and complete argv protocol", async () => {
    const valid = {
      resume: ["codex", "exec", "resume", "{id}", "--json", "{prompt}"],
      sessionIdentity: {
        event: "thread.started",
        field: "thread_id",
        requiredArgument: "--json",
        source: "stdout-jsonl",
      },
      spawn: ["codex", "exec", "--json", "{prompt}"],
    } satisfies { resume: string[]; sessionIdentity: SessionIdentityRecipe; spawn: string[] };
    await writeHarnesses({ codex: valid });
    const registry = await loadRegistry(regPath);
    const recipe = registry && resolveRecipe(registry, "codex")?.recipe;
    expect(recipe?.sessionIdentity).toEqual({ ...valid.sessionIdentity, allowRotation: false });

    for (const malformed of [
      { ...valid, spawn: ["codex", "exec", "{prompt}"] },
      { ...valid, resume: ["codex", "exec", "resume", "{id}", "{prompt}"] },
      { ...valid, resume: ["codex", "exec", "resume", "--json", "{prompt}"] },
      { ...valid, sessionIdentity: { ...valid.sessionIdentity, event: "x".repeat(129) } },
      { ...valid, sessionIdentity: { ...valid.sessionIdentity, field: "thread\nid" } },
    ]) {
      await writeHarnesses({ codex: malformed });
      await expect(loadRegistry(regPath)).rejects.toMatchObject({ code: "HSI001" });
    }
  });

  test("legacy identity-free recipes load for diagnosis but refuse unattended use as HSI001", async () => {
    await writeHarnesses({ legacy: { spawn: ["legacy", "{prompt}"] } });
    const registry = await loadRegistry(regPath);
    const resolved = registry && resolveRecipe(registry, "legacy");
    expect(resolved?.recipe.sessionIdentity).toBeUndefined();
    expect(() => requireSessionIdentity("legacy", resolved?.recipe, regPath)).toThrow(
      /identity strategy/,
    );
    try {
      requireSessionIdentity("legacy", resolved?.recipe, regPath);
    } catch (error) {
      expect(error).toMatchObject({ code: "HSI001", detail: { harness: "legacy", path: regPath } });
    }
  });
});

describe("the launcher yields to a human, not to its own identity record", () => {
  test("an identity sidecar is not attendance; an attendance sidecar is", async () => {
    // The launcher plants an identity sidecar naming the REAL harness before
    // it spawns (so a child that dies pre-open is still resumable). Reading
    // that as "a human attached" made attendChild return on its first pass
    // and left every forked artifact one-shot. What distinguishes them is
    // `nextCursor`: only a reader that took delivery records one.
    const identityOnly = { at: "2026-08-01T10:00:00.000Z", harness: "claude-code" };
    const attended = { ...identityOnly, nextCursor: "evt_00007" };
    const launcherOwn = { ...attended, harness: "lucid-launcher" };
    expect(attendedByAnother(identityOnly)).toBe(false);
    expect(attendedByAnother(attended)).toBe(true);
    // The launcher's own attendance record is not somebody else.
    expect(attendedByAnother(launcherOwn)).toBe(false);
  });
});

describe("safe fork ids", () => {
  test("strips path-traversal characters so a fork dir stays under the session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lucid-safe-"));
    try {
      const paths = sessionPaths(join(dir, "plan.html"));
      const evil = forkDirFor(paths, "../../../../etc/passwd");
      // The result must remain inside the session's forks/ directory.
      expect(evil.dir.startsWith(join(paths.sessionDir, "forks"))).toBe(true);
      expect(evil.dir).not.toContain("..");
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

  test("an element region is quoted as its visible text, not as its markup", async () => {
    // The seed is the spawned agent's whole context (#12). An outerHTML region
    // handed over raw made the blockquote markup soup: every tag, no sentence.
    const fork: ForkRecord = {
      id: "fk2",
      seq: 3,
      version: 1,
      target: elementTarget('<li class="row"><b>Backfill</b> from the archive</li>'),
      note: "plan it",
      at: "2026-01-01T00:00:00Z",
    };
    const { seedPath } = await writeForkSeed(paths, fork);
    const body = await readFile(seedPath, "utf8");
    expect(body).toContain("> Backfill from the archive");
    expect(body).not.toContain("<li");
  });

  test("a multi-line selection keeps its lines, because the seed quotes them", async () => {
    const fork: ForkRecord = {
      id: "fk3",
      seq: 4,
      version: 1,
      target: {
        kind: "range",
        quote: { exact: "first line\nsecond line", prefix: "", suffix: "" },
        position: { start: 0, end: 22 },
        snippet: "first line\nsecond line",
      },
      note: "plan it",
      at: "2026-01-01T00:00:00Z",
    };
    const { seedPath } = await writeForkSeed(paths, fork);
    const body = await readFile(seedPath, "utf8");
    expect(body).toContain("> first line\n> second line");
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
        harnesses: {
          stub: {
            sessionIdentity: {
              event: "thread.started",
              field: "thread_id",
              requiredArgument: "--json",
              source: "stdout-jsonl",
            },
            spawn: [process.execPath, STUB, "--json", "{seed}", "{artifact}"],
          },
        },
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
    await appendEvent(parent, {
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
    // The DISCOVERED identity is what the attend loop will resume: the stub
    // announced its own thread id, and that - never a Lucid-minted UUID - is
    // the child's resumable session.
    expect(created[0]?.childSessionId).toBe("stub-thread-0001");

    const childPaths = sessionPaths(created[0]?.childArtifact ?? "");
    // The stub authored the child artifact from the seed directive.
    expect(await readFile(childPaths.artifactPath, "utf8")).toContain("greeting");
    // And the binding is durable in the child's log, right where resume
    // resolution will look for it.
    const childEvents = (await readEvents(childPaths.logPath)).events;
    const bound = childEvents.filter((e) => e.t === "harness_session_bound");
    expect(bound).toHaveLength(1);
    expect(foldLog(childEvents).bindings[0]).toMatchObject({
      authority: "observed",
      harness: "stub",
      sessionId: "stub-thread-0001",
    });
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

  test("a caller-assigned fork hands the child the id Lucid minted, with authority", async () => {
    // The OTHER identity strategy through the same createChild path: Lucid
    // mints the id, the argv carries it adjacent to the declared flag, and
    // the child's env says who vouches for it.
    const assignedStub = join(dir, "assigned-stub.ts");
    const envDump = join(dir, "assigned-env.json");
    await writeFile(
      assignedStub,
      `const args = process.argv.slice(2);
const sid = args[args.indexOf("--sid") + 1];
const [seedPath, artifactPath] = args.filter((a, i) => a !== "--sid" && args[i - 1] !== "--sid");
await Bun.write(${JSON.stringify(envDump)}, JSON.stringify({
  argvSid: sid,
  envSid: process.env.LUCID_SESSION_ID ?? null,
  envAuthority: process.env.LUCID_SESSION_ID_AUTHORITY ?? null,
  envLaunch: process.env.LUCID_LAUNCH_ID ?? null,
}));
const seed = await Bun.file(seedPath).text();
const directive = seed.match(/\\*\\*Directive:\\*\\* (.*)/)?.[1] ?? "forked artifact";
await Bun.write(artifactPath, \`<!doctype html><html><head><title>x</title></head><body><h1 data-lucid-id="t">\${directive}</h1></body></html>\`);
`,
    );
    await writeFile(
      regPath,
      JSON.stringify({
        default: "assigned",
        harnesses: {
          assigned: {
            sessionIdentity: { argument: "--sid", source: "caller-assigned" },
            spawn: [process.execPath, assignedStub, "--sid", "{id}", "{seed}", "{artifact}"],
          },
        },
      }),
    );
    await appendEvent(parent, {
      t: "fork",
      id: "fork-assigned",
      version: 1,
      target: elementTarget("Hello"),
      note: "assigned-identity child",
    });
    const registry = await loadRegistry(regPath);
    expect(registry).not.toBeNull();
    if (!registry) return;
    const created = await handleForks(parent, registry, {
      openBrowser: false,
      openChild,
      log: () => {},
    });
    expect(created[0]?.status).toBe("created");
    const seen = JSON.parse(await readFile(envDump, "utf8")) as Record<string, string | null>;
    // One id, three witnesses: the argv token, the child env, and the loop's
    // resume target all name the id Lucid minted.
    expect(seen.argvSid).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen.envSid).toBe(seen.argvSid ?? "");
    expect(seen.envAuthority).toBe("assigned");
    expect(seen.envLaunch).toMatch(/^[a-f0-9]{16}$/);
    expect(created[0]?.childSessionId).toBe(seen.argvSid ?? "");
    // And the assigned binding is durable in the child's log.
    const childPaths2 = sessionPaths(created[0]?.childArtifact ?? "");
    const bound = (await sessionState(childPaths2)).bindings;
    expect(bound[0]).toMatchObject({ authority: "assigned", sessionId: seen.argvSid });
  });

  test("a corrupt handled.json throws rather than silently re-spawning every fork", async () => {
    await appendEvent(parent, {
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

describe("the launcher opens a child through the locked owner (finding #16)", () => {
  /**
   * `ensureChildOpen` used to rerun discover -> remove -> spawn -> wait itself,
   * with the two lower-level functions imported instead of the composed one -
   * so the descriptor lock `ensureServer` holds simply did not apply to a fork
   * child. Two openers of one deterministic child path (or a detached server
   * still booting after the child's own `lucid open` died with its turn) both
   * spawned, leaving two servers appending to one log. It also never wrote the
   * registry pointer `open` writes, so a forked artifact was invisible to
   * anything that discovers sessions.
   */
  let dir: string;
  let child: SessionPaths;
  let regFile: string;
  let stubs: Array<ReturnType<typeof Bun.serve>>;

  /** Stand-in for `spawnServer`: answers the handshake and publishes its
   *  descriptor as `__serve` does, but in-process so starts can be counted. */
  const startStub = async (): Promise<void> => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (): Response =>
        Response.json({ lucid: true, session: child.artifactPath, port: server.port, version: 1 }),
    });
    stubs.push(server);
    const port = server.port;
    if (port === undefined) throw new Error("stub did not bind");
    await writeServerDescriptor(child, {
      port,
      pid: process.pid,
      session: child.artifactPath,
      startedAt: new Date().toISOString(),
    });
  };

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-child-open-")));
    child = sessionPaths(join(dir, "review-fork-1.html"));
    await writeFile(child.artifactPath, DOC);
    ensureSessionDirs(child);
    regFile = join(dir, "registry.json");
    process.env.LUCID_REGISTRY = regFile;
    stubs = [];
  });

  afterEach(async () => {
    for (const s of stubs) s.stop(true);
    applyUnitEnv();
    await rm(dir, { recursive: true, force: true });
  });

  test("two openers of one child start one server", async () => {
    let spawned = 0;
    const spawn = (): void => {
      spawned++;
      // Not awaited: the real spawn returns before the server is up, which is
      // the window the race lives in.
      void startStub();
    };

    const [a, b] = await Promise.all([
      ensureChildOpen(child, false, { spawn, waitMs: 4000 }),
      ensureChildOpen(child, false, { spawn, waitMs: 4000 }),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(spawned).toBe(1);
    expect(stubs).toHaveLength(1);
  });

  test("the child lands in the registry, like any session `open` opened", async () => {
    const opened = await ensureChildOpen(child, false, {
      spawn: () => void startStub(),
      waitMs: 4000,
    });
    expect(opened).toBe(true);
    expect((await readRegistry(regFile)).map((e) => e.artifact)).toEqual([child.artifactPath]);
  });

  test("an unauthored child is still a failure, and starts nothing", async () => {
    await rm(child.artifactPath);
    let spawned = 0;
    expect(
      await ensureChildOpen(child, false, {
        spawn: () => {
          spawned++;
        },
        waitMs: 500,
      }),
    ).toBe(false);
    expect(spawned).toBe(0);
    expect(await readRegistry(regFile)).toEqual([]);
  });
});

describe("the launcher's Shape-C resume runs through the turn owner", () => {
  /**
   * The fork launcher and the hub's attend engine drive the same turn, and for
   * a long time they drove it differently: the launcher passed no stall
   * deadline (so a wedged child held its artifact for the launcher's whole
   * life), built its resume argv with a bare buildArgv (so a fork child
   * silently ignored the model its human had picked), and open-coded the
   * HSI005 test instead of asking the classifier. One owner answers all three
   * now, so these are properties of `attendChild` rather than of a copy.
   */
  let dir: string;
  let child: SessionPaths;
  let marker: string;
  let resumeStub: string;
  let store: string;
  const servers: { paths: SessionPaths; done: Promise<void> }[] = [];
  const logs: string[] = [];

  /** Named "claude-code" because the selection adapter's flag spellings are
   *  per-harness knowledge, and this fixture is about the flags arriving. */
  const HARNESS = "claude-code";
  const SESSION = "the-recorded-session";

  /** A DISCOVERED recipe, whose resume announces `thread_id` on stdout the way
   *  a real one does, or a caller-assigned one, which announces nothing. */
  const recipe = (identity: "announced" | "assigned"): SpawnRecipe => ({
    sessionIdentity:
      identity === "announced"
        ? {
            event: "thread.started",
            field: "thread_id",
            requiredArgument: "--json",
            source: "stdout-jsonl",
          }
        : { argument: "--sid", source: "caller-assigned" },
    spawn: [resumeStub, "--sid", "{id}", "{artifact}", "{prompt}"],
    resume:
      identity === "announced"
        ? [resumeStub, "--json", "{id}", "{artifact}", "{prompt}"]
        : [resumeStub, "--sid", "{id}", "{artifact}", "{prompt}"],
    models: [{ id: "opus-5" }],
    efforts: ["high"],
  });

  const writeResumeStub = async (body: string): Promise<void> => {
    await writeFile(resumeStub, `#!/usr/bin/env bun\n${body}\n`);
    await chmod(resumeStub, 0o755);
  };

  /** The note that drives a batch. It has to land AFTER the loop is blocked in
   *  `wait`: the loop starts from the log's current high seq, because a fresh
   *  child has no prior feedback to re-apply. */
  const annotate = (): Promise<unknown> =>
    appendEvent(child, {
      t: "annotation",
      id: "a-child",
      version: 1,
      target: elementTarget("Hello"),
      note: "apply this to the forked child",
    });

  const endChildSession = async (): Promise<void> => {
    const live = await discoverLiveServer(child);
    if (!live) return;
    await fetch(`http://127.0.0.1:${live.port}/__lucid/end`, {
      method: "POST",
      headers: { host: `127.0.0.1:${live.port}` },
    }).catch(() => {});
  };

  const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return predicate();
  };

  beforeEach(async () => {
    logs.length = 0;
    dir = await mkdtemp(join(tmpdir(), "lucid-attend-child-"));
    child = sessionPaths(join(dir, "child.html"));
    marker = join(dir, "resume-marker.json");
    resumeStub = join(dir, "resume-stub");
    // The harness store the resume pre-flight reads, and the activity signal
    // the stall watchdog reads while the turn runs - one walk answers both.
    // `LUCID_CLAUDE_PROJECTS` is already contained by the preload, so a test
    // that wants the fixture conversation to EXIST has to put it there.
    store = join(dir, "claude-projects");
    await mkdir(join(store, "child-store"), { recursive: true });
    await writeFile(join(store, "child-store", `${SESSION}.jsonl`), "");
    process.env.LUCID_CLAUDE_PROJECTS = store;
    await writeFile(child.artifactPath, DOC);
    ensureSessionDirs(child);
    await openSession(child);
    // The loop blocks in `wait`, which reports a session with no live server as
    // suspended and stops. A real in-process server is the seam the fork tests
    // above already use.
    servers.push({ paths: child, done: runServer(child, [0], { idleMs: 0 }) });
    for (let i = 0; i < 200 && !(await readServerDescriptor(child)); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // The sticky pick every resume turn must carry.
    await writeFile(child.selectionPath, JSON.stringify({ harness: HARNESS, model: "opus-5" }));
  });

  afterEach(async () => {
    for (const s of servers) {
      await endChildSession();
      await s.done.catch(() => {});
    }
    servers.length = 0;
    // Put the containment back rather than deleting it: the borrowed value
    // points into a directory this teardown removes.
    applyUnitEnv();
    await rm(dir, { recursive: true, force: true });
  });

  test("a fork resume carries the artifact's sticky selection and closes its own turn", async () => {
    // The argv was built with a bare buildArgv, so `selection.json` - the pick
    // the human made in the child's own viewer - reached the hub's resumes and
    // never the launcher's. And the turn's window was only closed on the two
    // refusal paths, so an ordinary resume left an ack nothing ever answered.
    await writeResumeStub(
      `await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2) }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "a-stranger-thread" }));`,
    );

    const loop = attendChild(
      child,
      SESSION,
      recipe("announced"),
      { log: (m) => logs.push(m) },
      HARNESS,
    );
    await new Promise((r) => setTimeout(r, 200));
    await annotate();
    await loop;

    const seen = JSON.parse(await readFile(marker, "utf8")) as { argv: string[] };
    expect(seen.argv.slice(0, 2)).toEqual(["--model", "opus-5"]);
    const events = (await readEvents(child.logPath)).events;
    const ack = events.find((e) => e.t === "agent_ack") as { turnId?: string } | undefined;
    const ended = events.find((e) => e.t === "agent_turn_ended") as
      | { turnId?: string; reason?: string; code?: string }
      | undefined;
    expect(ack?.turnId).toBeDefined();
    // The window the ack opened is closed by a terminator naming the SAME turn.
    expect(ended?.turnId).toBe(ack?.turnId ?? "");
    // Judged by the shared classifier: the stub answered from a conversation
    // nobody asked for, so the turn failed however cleanly it exited.
    expect(ended?.reason).toBe("failed");
    expect(ended?.code).toBe("hsi005_session_mismatch");
    expect(logs.some((l) => l.includes("HSI005"))).toBe(true);
  }, 30_000);

  test("a clean fork resume closes its own turn and stamps what it established", async () => {
    // The refusal paths above are the ones that always had a terminator. The
    // ORDINARY turn - the overwhelmingly common one - had none: the ack opened
    // a window nothing ever closed, so the panel reported a finished turn as
    // the live one and the next batch queued behind a delivery that was over.
    await writeResumeStub(
      `console.log(JSON.stringify({ type: "thread.started", thread_id: ${JSON.stringify(SESSION)} }));`,
    );

    const loop = attendChild(
      child,
      SESSION,
      recipe("announced"),
      { log: (m) => logs.push(m) },
      HARNESS,
    );
    await new Promise((r) => setTimeout(r, 200));
    await annotate();
    interface Terminator {
      readonly turnId?: string;
      readonly reason?: string;
      readonly code?: string;
      readonly attendant?: {
        readonly harness?: string;
        readonly sessionId?: string;
        readonly launchId?: string;
        readonly sessionIdAuthority?: string;
      };
    }
    const terminator = async (): Promise<Terminator | undefined> =>
      (await readEvents(child.logPath)).events.find((e) => e.t === "agent_turn_ended") as
        | Terminator
        | undefined;
    let ended: Terminator | undefined;
    const deadline = Date.now() + 20_000;
    while (!ended && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      ended = await terminator();
    }
    // A clean turn consumes its batch and blocks in `wait` for the next one:
    // ending the session is how this loop stops.
    await endChildSession();
    await loop;

    const ack = (await readEvents(child.logPath)).events.find((e) => e.t === "agent_ack") as
      | { turnId?: string }
      | undefined;
    expect(ack?.turnId).toBeDefined();
    expect(ended?.turnId).toBe(ack?.turnId ?? "");
    expect(ended?.reason).toBe("done");
    expect(ended?.code).toBeUndefined();
    // What the turn ESTABLISHED, with authority that matches the evidence: the
    // harness announced the very id that was asked for, so the stamp says the
    // id was observed rather than merely recorded.
    expect(ended?.attendant?.harness).toBe(HARNESS);
    expect(ended?.attendant?.sessionId).toBe(SESSION);
    expect(ended?.attendant?.sessionIdAuthority).toBe("observed");
    expect(typeof ended?.attendant?.launchId).toBe("string");
  }, 30_000);

  test("a resume with no local transcript is refused before a process exists", async () => {
    // The hub's engine pre-flights this and the launcher did not: it spawned a
    // `--resume` whose conversation this machine does not hold, then measured
    // it against the only signal left (a zero-byte out-log) and burned the
    // batch three attempts later. The store walk that feeds the watchdog
    // answers the question before there is anything to watch.
    await writeResumeStub(`await Bun.write(${JSON.stringify(marker)}, "spawned");`);
    process.env.LUCID_CLAUDE_PROJECTS = join(dir, "no-claude-projects");

    const loop = attendChild(
      child,
      SESSION,
      recipe("assigned"),
      { log: (m) => logs.push(m) },
      HARNESS,
    );
    await new Promise((r) => setTimeout(r, 200));
    await annotate();
    await loop;

    expect(logs.some((l) => l.includes("no local") && l.includes(SESSION))).toBe(true);
    expect(
      await readFile(marker, "utf8").then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    // The batch stays the human's: with no turn to run, nothing takes delivery
    // of it and no window is opened that no terminator will close.
    const events = (await readEvents(child.logPath)).events;
    expect(events.some((e) => e.t === "agent_ack")).toBe(false);
  }, 30_000);

  test("a wedged fork resume is killed rather than held for the launcher's lifetime", async () => {
    // No deadline reached runSpawn from here, so the watchdog - written for
    // exactly this - protected only the hub. A child that writes nothing held
    // its artifact until the launcher itself died, and the loop never got as
    // far as calling the turn a failure.
    await writeResumeStub("await Bun.sleep(600_000);");

    const loop = attendChild(
      child,
      SESSION,
      recipe("assigned"),
      { log: (m) => logs.push(m), stallIdleMs: 800 },
      HARNESS,
    );
    await new Promise((r) => setTimeout(r, 200));
    await annotate();
    const moved = await until(() => logs.some((l) => l.includes("will retry the batch")), 20_000);
    expect(moved).toBe(true);
    // Ending the session is how this loop stops; without it the launcher keeps
    // holding its listening presence, which is the whole point of Shape C.
    await endChildSession();
    await loop;
  }, 40_000);
});

describe("M1.6: a fork create runs through the turn owner", () => {
  /**
   * The fork create used to be a parallel reimplementation of the turn: it
   * built its own argv (buildArgv), recorded its own identity
   * (prepareSpawnIdentity.recordAssigned), and ran runSpawn directly - so it
   * had no ack/terminator bracketing, no sticky selection, and the hub's
   * create (already on planTurn/runTurn) was the only create that did. One
   * owner answers all of it now: createChild routes through
   * planTurn({mode:"create"}) + runTurn, the identity pre-record lives in the
   * pipeline, and a fresh log never opens with an ack (M9-ack).
   */
  let dir: string;
  let paths: SessionPaths;
  let createStub: string;
  let outLog: string;

  const writeStub = async (body: string): Promise<void> => {
    await writeFile(createStub, `#!/usr/bin/env bun\n${body}\n`);
    await chmod(createStub, 0o755);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-create-turn-"));
    paths = sessionPaths(join(dir, "child.html"));
    createStub = join(dir, "create-stub");
    outLog = join(dir, "create.out.log");
    await writeFile(paths.artifactPath, DOC);
    ensureSessionDirs(paths);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("{seed} substitutes through planTurn for a create turn", async () => {
    const seedPath = join(dir, "seed.md");
    await writeFile(seedPath, "# seed");
    const recipe: SpawnRecipe = {
      sessionIdentity: { argument: "--sid", source: "caller-assigned" },
      spawn: [createStub, "--sid", "{id}", "{seed}", "{artifact}", "{prompt}"],
    };
    const planned = await planTurn({
      mode: "create",
      paths,
      harness: "stub",
      recipe,
      registryFile: join(dir, "reg.json"),
      cwd: dir,
      prompt: "author it",
      seed: seedPath,
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    // The seed path reaches the argv where the recipe declared {seed}.
    expect(planned.argv).toContain(seedPath);
    // A caller-assigned create mints the id planTurn substitutes for {id}.
    expect(planned.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(planned.argv).toContain(planned.sessionId ?? "");
  });

  test("a create turn weaves the artifact's sticky selection into argv", async () => {
    // planTurn reads the selection sidecar for every mode; a fork child whose
    // human picked a model gets that pick woven into its CREATE argv, not
    // only into later resumes.
    await writeFile(
      paths.selectionPath,
      JSON.stringify({ harness: "claude-code", model: "opus-5" }),
    );
    const recipe: SpawnRecipe = {
      sessionIdentity: { argument: "--sid", source: "caller-assigned" },
      spawn: [createStub, "--sid", "{id}", "{prompt}"],
      models: [{ id: "opus-5" }],
      efforts: ["high"],
    };
    const planned = await planTurn({
      mode: "create",
      paths,
      harness: "claude-code",
      recipe,
      registryFile: join(dir, "reg.json"),
      cwd: dir,
      prompt: "author it",
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    expect(planned.argv.slice(1, 3)).toEqual(["--model", "opus-5"]);
  });

  test("a create turn appends no ack to a fresh log and closes with a terminator", async () => {
    // M9-ack: the ack used to be the first thing appended, so a fresh record
    // opened with agent_ack and session_opened landed second. A create turn
    // owns no batch to claim, so its ack is skipped entirely when the log
    // does not exist yet. The terminator still lands: the turn ended.
    await writeStub("process.exit(0);");
    const recipe: SpawnRecipe = {
      sessionIdentity: { argument: "--sid", source: "caller-assigned" },
      spawn: [createStub, "--sid", "{id}"],
    };
    const planned = await planTurn({
      mode: "create",
      paths,
      harness: "stub",
      recipe,
      registryFile: join(dir, "reg.json"),
      cwd: dir,
      prompt: "author it",
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    await runTurn(planned, { outLog });
    const events = (await readEvents(paths.logPath)).events;
    // No ack opens a window on a log that did not exist.
    expect(events.some((e) => e.t === "agent_ack")).toBe(false);
    // The turn still closes its own window: a terminator names the turn.
    const ended = events.find((e) => e.t === "agent_turn_ended") as { turnId?: string } | undefined;
    expect(ended?.turnId).toBe(planned.turnId);
  });

  test("session_opened stays first when the agent opens mid-spawn, and the stem-collision guard is active", async () => {
    // A real authoring agent writes the artifact AND runs `lucid open` during
    // its turn, so session_opened lands BEFORE the terminator. The stub
    // simulates that mid-spawn open by appending a session_opened line; the
    // create turn's ack is skipped, so session_opened is the first line the
    // record ever holds - which is what the stem-collision guard (D-006)
    // reads to tell its own record from a stranger's.
    const logPath = paths.logPath;
    const artifactPath = paths.artifactPath;
    const owner = basename(artifactPath);
    await writeStub(
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(artifactPath)}, ${JSON.stringify(DOC)});`,
        "fs.appendFileSync(" +
          JSON.stringify(logPath) +
          ', JSON.stringify({seq:1,at:"2026-01-01T00:00:00.000Z",t:"session_opened",segment:1,artifact:' +
          JSON.stringify(owner) +
          ',version:1,hash:"x",path:"x"}) + "\\n");',
        "process.exit(0);",
      ].join("\n"),
    );
    const recipe: SpawnRecipe = {
      sessionIdentity: { argument: "--sid", source: "caller-assigned" },
      spawn: [createStub, "--sid", "{id}"],
    };
    const planned = await planTurn({
      mode: "create",
      paths,
      harness: "stub",
      recipe,
      registryFile: join(dir, "reg.json"),
      cwd: dir,
      prompt: "author it",
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    await runTurn(planned, { outLog });
    const events = (await readEvents(paths.logPath)).events;
    // session_opened is the FIRST event; no ack precedes it.
    expect(events[0]?.t).toBe("session_opened");
    expect(events.some((e) => e.t === "agent_ack")).toBe(false);
    // The guard reads that first line: a same-stem artifact sharing this
    // record dir is refused as a collision, not silently merged.
    const sameStem = sessionPaths(join(dir, "child.md"));
    expect(() => assertRecordAvailable(sameStem)).toThrow(/already the review record/);
  });

  test("a create turn records its assigned identity before the process opens (crash-before-open)", async () => {
    // The identity pre-record used to be the caller's job (recordAssigned in
    // createChild, recordPendingIdentity in the daemon). Moved into the
    // pipeline: a create that crashes before it ever opens still leaves a
    // resumable sidecar.
    await writeStub("process.exit(1);"); // crashes immediately, opens nothing
    const recipe: SpawnRecipe = {
      sessionIdentity: { argument: "--sid", source: "caller-assigned" },
      spawn: [createStub, "--sid", "{id}"],
    };
    const planned = await planTurn({
      mode: "create",
      paths,
      harness: "stub",
      recipe,
      registryFile: join(dir, "reg.json"),
      cwd: dir,
      prompt: "author it",
    });
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") return;
    await runTurn(planned, { outLog });
    const sidecar = await readLastAttendant(paths);
    // The assigned id is pending in the sidecar even though the turn never
    // opened the session - the pipeline recorded it before spawn.
    expect(sidecar?.sessionId).toBe(planned.sessionId);
    expect(sidecar?.sessionIdAuthority).toBe("assigned");
    expect(sidecar?.pendingBinding).toBe(true);
  });
});
