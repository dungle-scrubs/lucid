import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { foldLog, type ForkRecord } from "../src/core/fold.ts";
import { appendEvent, readEvents } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { ensureSessionDirs, openSession } from "../src/core/session.ts";
import type { WaitPayload } from "../src/protocol/wire.ts";
import { attendedByAnother, childArtifactPath, handleForks } from "../src/launch/fork-launcher.ts";
import { createArtifactPrompt, createPrompt, revisePrompt } from "../src/launch/prompts.ts";
import {
  buildArgv,
  defaultRecipe,
  loadRegistry,
  requireSessionIdentity,
  resolveExactRecipe,
  resolveRecipe,
} from "../src/launch/recipes.ts";
import type { SessionIdentityRecipe } from "../src/launch/session-identity.ts";
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
    await appendEvent(parent.logPath, {
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
    const bound = foldLog((await readEvents(childPaths2.logPath)).events).bindings;
    expect(bound[0]).toMatchObject({ authority: "assigned", sessionId: seen.argvSid });
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
