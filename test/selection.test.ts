import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPaths } from "../src/core/paths.ts";
import {
  buildArgv,
  loadRegistry,
  resolveRecipe,
  spawnedSessionId,
  type SpawnRecipe,
} from "../src/launch/recipes.ts";
import {
  applySelection,
  insertSelectionArgs,
  readSelection,
  sanitizeSelection,
  selectionArgs,
  selectionPath,
  writeSelection,
} from "../src/launch/selection.ts";

/** The three real recipe shapes (docs/LAUNCHER.md + the seeded registry), so
 *  the placement rule is tested against argv Lucid actually builds. */
const CLAUDE: SpawnRecipe = {
  spawn: [
    "claude",
    "-p",
    "--session-id",
    "{id}",
    "{prompt}",
    "--allowedTools",
    "Bash(lucid *) Write Edit Read",
  ],
  resume: [
    "claude",
    "--resume",
    "{id}",
    "-p",
    "{prompt}",
    "--allowedTools",
    "Bash(lucid *) Write Edit Read",
  ],
  models: [{ id: "opus-5", label: "Opus 5" }, { id: "opus-4.8" }, { id: "sonnet-5" }],
  defaultModel: "opus-4.8",
  efforts: ["low", "medium", "high", "xhigh", "max"],
};

const CODEX: SpawnRecipe = {
  spawn: ["codex", "exec", "--json", "--sandbox", "workspace-write", "-C", "{cwd}", "{prompt}"],
  resume: ["codex", "exec", "resume", "{id}", "{prompt}"],
  models: [
    { id: "gpt-5.6-sol", efforts: ["medium", "high", "xhigh", "max", "ultra"] },
    { id: "gpt-5.5", efforts: ["minimal", "low", "medium", "high"] },
  ],
  defaultModel: "gpt-5.6-sol",
};

const PI: SpawnRecipe = {
  spawn: ["pi", "-p", "--session-id", "{id}", "{prompt}"],
  resume: ["pi", "-p", "--session-id", "{id}", "{prompt}"],
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
};

describe("spawnedSessionId", () => {
  test("reads codex's structured thread identity through unrelated output", () => {
    const output = [
      "starting",
      "{not json}",
      JSON.stringify({ type: "thread.started", thread_id: "019c-thread" }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    expect(spawnedSessionId("codex", output)).toBe("019c-thread");
  });

  test("does not infer another harness's session identity from its prose", () => {
    const output = JSON.stringify({ type: "thread.started", thread_id: "not-pi's-id" });
    expect(spawnedSessionId("pi", output)).toBeUndefined();
  });
});

describe("registry v2 parsing", () => {
  let dir: string;
  let regPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-sel-reg-"));
    regPath = join(dir, "harnesses.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Model/effort fields only load on a harness the adapter has flags for, so
   *  the shape tests below are written against a real one. */
  const write = (harness: unknown, name = "codex"): Promise<void> =>
    writeFile(regPath, JSON.stringify({ harnesses: { [name]: harness } }));

  test("a v1 entry (no model/effort fields) still loads unchanged", async () => {
    await write({ spawn: ["claude", "{prompt}"] }, "h");
    const reg = await loadRegistry(regPath);
    expect(reg?.harnesses.h?.spawn).toEqual(["claude", "{prompt}"]);
    expect(reg?.harnesses.h?.models).toBeUndefined();
    expect(reg?.harnesses.h?.efforts).toBeUndefined();
  });

  test("model/effort fields on a harness Lucid has no flags for are rejected", async () => {
    // A picker whose every pick is refused at spawn must not be offered at all.
    await write({ spawn: ["gemini", "{prompt}"], models: [{ id: "flash" }] }, "gemini");
    await expect(loadRegistry(regPath)).rejects.toThrow(/knows no such flags/);
    await write({ spawn: ["gemini", "{prompt}"], efforts: ["low", "high"] }, "gemini");
    await expect(loadRegistry(regPath)).rejects.toThrow(/knows no such flags/);
    await write({ spawn: ["gemini", "{prompt}"], defaultEffort: "low" }, "gemini");
    await expect(loadRegistry(regPath)).rejects.toThrow(/knows no such flags/);
  });

  test("a registry keyed the way the CLI names itself gets the same flags", async () => {
    // `claude-code` and `claude` are ONE family (core/harness.ts), so a
    // registry that keys the harness `claude` loads its models rather than
    // failing with "knows no such flags for it". Pinned here because the
    // family test is what grants it: narrowing `harnessKind` back to
    // `claude-code` alone would restore the load-time rejection, and this is
    // the surface where a user would meet it.
    await write({ spawn: ["claude", "{prompt}"], models: [{ id: "opus-5" }] }, "claude");
    const recipe = (await loadRegistry(regPath))?.harnesses.claude;
    expect(recipe?.models).toEqual([{ id: "opus-5" }]);
  });

  test("models, labels, per-model efforts and the defaults round-trip", async () => {
    await write({
      spawn: ["codex", "exec", "{prompt}"],
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["medium", "ultra"] },
        { id: "gpt-5.5", efforts: ["minimal", "high"] },
      ],
      defaultModel: "gpt-5.6-sol",
      defaultEffort: "ultra",
    });
    const recipe = (await loadRegistry(regPath))?.harnesses.codex;
    expect(recipe?.models).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["medium", "ultra"] },
      { id: "gpt-5.5", efforts: ["minimal", "high"] },
    ]);
    expect(recipe?.defaultModel).toBe("gpt-5.6-sol");
    expect(recipe?.defaultEffort).toBe("ultra");
  });

  test("a harness-wide ladder with no models loads (effort-only picker)", async () => {
    await write(
      { spawn: ["pi", "{prompt}"], efforts: ["off", "high"], defaultEffort: "high" },
      "pi",
    );
    const recipe = (await loadRegistry(regPath))?.harnesses.pi;
    expect(recipe?.efforts).toEqual(["off", "high"]);
    expect(recipe?.models).toBeUndefined();
  });

  test("a defaultModel outside its own models is rejected at load", async () => {
    await write({ spawn: ["x"], models: [{ id: "a" }], defaultModel: "b" });
    await expect(loadRegistry(regPath)).rejects.toThrow(/defaultModel "b"/);
  });

  test("a defaultEffort outside the ladder that applies is rejected at load", async () => {
    await write({
      spawn: ["x"],
      models: [{ id: "a", efforts: ["low"] }],
      defaultModel: "a",
      defaultEffort: "max",
    });
    await expect(loadRegistry(regPath)).rejects.toThrow(/defaultEffort "max"/);
  });

  test("a defaultEffort with no ladder anywhere is rejected at load", async () => {
    await write({ spawn: ["x"], defaultEffort: "high" });
    await expect(loadRegistry(regPath)).rejects.toThrow(/no effort levels/);
  });

  test("Object.prototype keys are not harnesses", async () => {
    // The selection route resolves a LOG-derived harness name, so an inherited
    // key must not answer as a recipe - and a registry naming `__proto__` must
    // add a key, not move the prototype.
    await write({ spawn: ["x"] }, "__proto__");
    const reg = await loadRegistry(regPath);
    expect(Object.keys(reg?.harnesses ?? {})).toEqual(["__proto__"]);
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      expect(resolveRecipe(reg as NonNullable<typeof reg>, key)).toBeUndefined();
    }
  });

  test("the rejection names the registry file so the typo is findable", async () => {
    await write({ spawn: ["x"], models: [{ id: "a" }], defaultModel: "b" });
    await expect(loadRegistry(regPath)).rejects.toThrow(
      expect.objectContaining({ detail: expect.objectContaining({ path: regPath }) }),
    );
  });

  test("malformed model shapes are rejected", async () => {
    await write({ spawn: ["x"], models: [{ label: "no id" }] });
    await expect(loadRegistry(regPath)).rejects.toThrow(/non-empty string `id`/);
    await write({ spawn: ["x"], models: [] });
    await expect(loadRegistry(regPath)).rejects.toThrow(/non-empty array/);
    await write({ spawn: ["x"], models: [{ id: "a" }, { id: "a" }] });
    await expect(loadRegistry(regPath)).rejects.toThrow(/twice/);
    await write({ spawn: ["x"], models: [{ id: "a", efforts: [] }] });
    await expect(loadRegistry(regPath)).rejects.toThrow(/non-empty string\[\]/);
    await write({ spawn: ["x"], efforts: ["ok", " "] });
    await expect(loadRegistry(regPath)).rejects.toThrow(/non-empty string\[\]/);
  });
});

describe("selectionArgs: the per-harness flags", () => {
  test("claude-code spells model and effort as --model/--effort", () => {
    expect(selectionArgs("claude-code", CLAUDE, { model: "opus-5", effort: "xhigh" })).toEqual([
      "--model",
      "opus-5",
      "--effort",
      "xhigh",
    ]);
  });

  test("codex spells both as -c config overrides, TOML-quoted", () => {
    expect(selectionArgs("codex", CODEX, { model: "gpt-5.6-sol", effort: "ultra" })).toEqual([
      "-c",
      'model="gpt-5.6-sol"',
      "-c",
      'model_reasoning_effort="ultra"',
    ]);
  });

  test("pi spells effort as --thinking", () => {
    expect(selectionArgs("pi", PI, { effort: "off" })).toEqual(["--thinking", "off"]);
  });

  test("one field alone emits only its own flag", () => {
    expect(selectionArgs("claude-code", CLAUDE, { model: "sonnet-5" })).toEqual([
      "--model",
      "sonnet-5",
    ]);
    expect(selectionArgs("claude-code", CLAUDE, { effort: "low" })).toEqual(["--effort", "low"]);
  });

  test('"default" and absent mean PASS NOTHING, never a synthesized value', () => {
    expect(selectionArgs("claude-code", CLAUDE, {})).toEqual([]);
    expect(selectionArgs("claude-code", CLAUDE, { model: "default", effort: "default" })).toEqual(
      [],
    );
    // Not even the recipe's own defaultModel: it is what the CLI already does.
    expect(selectionArgs("codex", CODEX, {})).toEqual([]);
  });

  test("an empty selection is [] even for a harness with no known flags", () => {
    expect(selectionArgs("mystery", { spawn: ["m"] }, {})).toEqual([]);
  });

  test("a selection on a harness with no known flags is an error, not a silent drop", () => {
    expect(selectionArgs("mystery", { spawn: ["m"] }, { effort: "high" })).toEqual({
      error: 'no model/effort flags are known for harness "mystery"',
    });
  });

  test("the docs' claude_code spelling is the same harness", () => {
    expect(selectionArgs("claude_code", CLAUDE, { model: "opus-5" })).toEqual([
      "--model",
      "opus-5",
    ]);
  });
});

describe("selectionArgs: validation against the registry", () => {
  test("a model outside the curated list is refused, naming the list", () => {
    const result = selectionArgs("claude-code", CLAUDE, { model: "gpt-5.6-sol" });
    expect(result).toEqual({
      error:
        'model "gpt-5.6-sol" is not in harness "claude-code"\'s models (opus-5, opus-4.8, sonnet-5)',
    });
  });

  test("a model on a harness that declares none cannot be validated, so it is refused", () => {
    expect(selectionArgs("pi", PI, { model: "anthropic/opus" })).toEqual({
      error: 'harness "pi" declares no models, so model "anthropic/opus" cannot be validated',
    });
  });

  test("an effort outside the harness-wide ladder is refused", () => {
    expect(selectionArgs("claude-code", CLAUDE, { effort: "ultra" })).toEqual({
      error:
        'effort "ultra" is not supported by harness "claude-code" (low, medium, high, xhigh, max)',
    });
    expect(selectionArgs("pi", PI, { effort: "max" })).toEqual({
      error:
        'effort "max" is not supported by harness "pi" (off, minimal, low, medium, high, xhigh)',
    });
  });

  test("codex efforts are validated per model generation", () => {
    // Late generation: ultra yes, minimal no.
    expect(selectionArgs("codex", CODEX, { model: "gpt-5.6-sol", effort: "ultra" })).not.toEqual(
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(selectionArgs("codex", CODEX, { model: "gpt-5.6-sol", effort: "minimal" })).toEqual({
      error:
        'effort "minimal" is not supported by model "gpt-5.6-sol" (medium, high, xhigh, max, ultra)',
    });
    // Pre-5.6: minimal yes, ultra no.
    expect(selectionArgs("codex", CODEX, { model: "gpt-5.5", effort: "minimal" })).toEqual([
      "-c",
      'model="gpt-5.5"',
      "-c",
      'model_reasoning_effort="minimal"',
    ]);
    expect(selectionArgs("codex", CODEX, { model: "gpt-5.5", effort: "ultra" })).toEqual({
      error: 'effort "ultra" is not supported by model "gpt-5.5" (minimal, low, medium, high)',
    });
  });

  test("with no model picked, the DEFAULT model's ladder applies - that is what runs", () => {
    // gpt-5.6-sol is the default, so "ultra" is legal and "minimal" is not.
    expect(selectionArgs("codex", CODEX, { effort: "ultra" })).toEqual([
      "-c",
      'model_reasoning_effort="ultra"',
    ]);
    expect(selectionArgs("codex", CODEX, { effort: "minimal" })).toEqual({
      error:
        'effort "minimal" is not supported by model "gpt-5.6-sol" (medium, high, xhigh, max, ultra)',
    });
  });

  test("a harness declaring no effort levels at all refuses an effort", () => {
    expect(selectionArgs("claude-code", { spawn: ["claude"] }, { effort: "high" })).toEqual({
      error: 'harness "claude-code" declares no effort levels',
    });
  });
});

describe("insertSelectionArgs: placement in a real argv", () => {
  const subs = { id: "sess-1", prompt: "revise it", cwd: "/proj" };

  test("claude: right after argv[0], never after the variadic --allowedTools", () => {
    const argv = insertSelectionArgs("claude-code", buildArgv(CLAUDE.spawn, subs), [
      "--model",
      "opus-5",
    ]);
    expect(argv).toEqual([
      "claude",
      "--model",
      "opus-5",
      "-p",
      "--session-id",
      "sess-1",
      "revise it",
      "--allowedTools",
      "Bash(lucid *) Write Edit Read",
    ]);
    // The prompt is still positional and the tool list is still last.
    expect(argv.at(-1)).toBe("Bash(lucid *) Write Edit Read");
  });

  test("claude resume keeps --resume's own argument adjacent", () => {
    const argv = insertSelectionArgs("claude-code", buildArgv(CLAUDE.resume ?? [], subs), [
      "--effort",
      "max",
    ]);
    expect(argv.slice(0, 5)).toEqual(["claude", "--effort", "max", "--resume", "sess-1"]);
  });

  test("codex: after the exec subcommand, before its own flags", () => {
    const argv = insertSelectionArgs("codex", buildArgv(CODEX.spawn, subs), [
      "-c",
      'model="gpt-5.6-sol"',
    ]);
    expect(argv).toEqual([
      "codex",
      "exec",
      "-c",
      'model="gpt-5.6-sol"',
      "--json",
      "--sandbox",
      "workspace-write",
      "-C",
      "/proj",
      "revise it",
    ]);
  });

  test("codex resume: after BOTH subcommand tokens", () => {
    const argv = insertSelectionArgs("codex", buildArgv(CODEX.resume ?? [], subs), [
      "-c",
      'model_reasoning_effort="high"',
    ]);
    expect(argv).toEqual([
      "codex",
      "exec",
      "resume",
      "-c",
      'model_reasoning_effort="high"',
      "sess-1",
      "revise it",
    ]);
  });

  test("pi: right after argv[0]", () => {
    const argv = insertSelectionArgs("pi", buildArgv(PI.spawn, subs), ["--thinking", "high"]);
    expect(argv).toEqual(["pi", "--thinking", "high", "-p", "--session-id", "sess-1", "revise it"]);
  });

  test("no args leaves the argv byte-identical", () => {
    const built = buildArgv(CODEX.spawn, subs);
    expect(insertSelectionArgs("codex", built, [])).toEqual(built);
  });

  test("codex: a substituted value spelling `exec` cannot move the insertion", () => {
    // The index comes off the template, so a project directory named `exec`
    // does not put the overrides against `-C`'s own argument.
    const argv = insertSelectionArgs(
      "codex",
      buildArgv(CODEX.spawn, { ...subs, cwd: "exec" }),
      ["-c", 'model="gpt-5.5"'],
      CODEX.spawn,
    );
    expect(argv.slice(0, 4)).toEqual(["codex", "exec", "-c", 'model="gpt-5.5"']);
  });

  test("codex: a wrapper's own `exec` does not win over the harness's", () => {
    const wrapped = ["direnv", "exec", ".", "codex", "exec", "{prompt}"];
    const argv = insertSelectionArgs(
      "codex",
      buildArgv(wrapped, subs),
      ["-c", 'model="gpt-5.5"'],
      wrapped,
    );
    expect(argv).toEqual([
      "direnv",
      "exec",
      ".",
      "codex",
      "exec",
      "-c",
      'model="gpt-5.5"',
      "revise it",
    ]);
  });
});

describe("applySelection", () => {
  test("validates and weaves in one step", () => {
    expect(
      applySelection("pi", PI, buildArgv(PI.spawn, { id: "s", prompt: "go" }), { effort: "xhigh" }),
    ).toEqual(["pi", "--thinking", "xhigh", "-p", "--session-id", "s", "go"]);
  });

  test("a refused selection never reaches an argv", () => {
    expect(applySelection("pi", PI, ["pi"], { effort: "ultra" })).toEqual({
      error:
        'effort "ultra" is not supported by harness "pi" (off, minimal, low, medium, high, xhigh)',
    });
  });
});

describe("sanitizeSelection", () => {
  test("keeps clean fields and drops the rest", () => {
    expect(sanitizeSelection({ harness: "codex", model: "gpt-5.5", effort: "high" })).toEqual({
      harness: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    expect(sanitizeSelection({ model: 7, effort: null })).toBeUndefined();
    expect(sanitizeSelection(null)).toBeUndefined();
    expect(sanitizeSelection({})).toBeUndefined();
  });

  test('"default" is not a value: it clears the field', () => {
    expect(sanitizeSelection({ model: "default", effort: "high" })).toEqual({ effort: "high" });
    expect(sanitizeSelection({ model: "default", effort: "default" })).toBeUndefined();
  });

  test("control characters are stripped and lengths bounded", () => {
    expect(sanitizeSelection({ model: "op\u0000us\n-5" })).toEqual({ model: "opus-5" });
    const long = sanitizeSelection({ effort: "h".repeat(200) });
    expect(long?.effort?.length).toBe(32);
  });
});

describe("the sticky sidecar", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-sel-side-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("what is written is exactly what is read back", async () => {
    // Bounded on the way out too: a value only clipped on read would stop
    // matching its own registry entry, and every later resume would reject the
    // pick it had just accepted.
    // selection.json is machine-local, under run/ (plan 02).
    const runDir = join(dir, "run");
    const paths = {
      sessionDir: dir,
      runDir,
      selectionPath: join(runDir, "selection.json"),
    } as SessionPaths;
    await writeSelection(paths, { harness: "codex", model: "m".repeat(200), effort: " high " });
    const stored = (await Bun.file(selectionPath(paths)).json()) as Record<string, string>;
    expect(stored).toEqual((await readSelection(paths)) as unknown as Record<string, string>);
    expect(stored.model?.length).toBe(128);
    expect(stored.effort).toBe("high");
  });
});
