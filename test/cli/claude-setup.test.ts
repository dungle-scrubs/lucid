import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.js";

const argv = (file: string) => [
  "connection",
  "setup",
  "--interface",
  "claude-cli",
  "--settings-file",
  file,
  "--json",
];

test("Claude Code setup preserves other settings and hooks and repeating it changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-claude-setup-"));
  try {
    const file = join(root, "settings.json");
    const existing = {
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "printf read" }] }],
        Stop: [{ hooks: [{ type: "command", command: "printf existing-stop" }] }],
      },
    };
    writeFileSync(file, JSON.stringify(existing));
    const output: string[] = [];
    const deps = { rootDir: join(root, "records"), onOutput: (line: string) => output.push(line) };
    expect(await dispatch(argv(file), deps)).toEqual({
      kind: "connection-setup",
      verdict: "installed",
    });
    expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
      ready: false,
      status: "installed",
      trustRequired: true,
    });
    const bytes = readFileSync(file, "utf8");
    const saved = JSON.parse(bytes);
    expect(saved.permissions).toEqual(existing.permissions);
    expect(saved.hooks.PostToolUse[0]).toEqual(existing.hooks.PostToolUse[0]);
    expect(saved.hooks.PostToolUse[1]).toMatchObject({
      matcher: "Bash",
      hooks: [{ timeout: 30, type: "command" }],
    });
    expect(saved.hooks.Stop[1].hooks[0]).toMatchObject({
      statusMessage: "Listening for Lucid feedback (up to 45 seconds)",
      timeout: 60,
    });
    expect(Object.keys(saved.hooks)).toEqual([
      "PostToolUse",
      "Stop",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    expect(saved.hooks.UserPromptSubmit[0].hooks[0].command).toContain("_claude-hook");
    expect(await dispatch(argv(file), deps)).toEqual({
      kind: "connection-setup",
      verdict: "unchanged",
    });
    expect(readFileSync(file, "utf8")).toBe(bytes);

    const changed = JSON.parse(bytes);
    changed.hooks.PostToolUse[1].matcher = "*";
    writeFileSync(file, JSON.stringify(changed));
    expect(await dispatch(argv(file), deps)).toEqual({
      kind: "connection-setup",
      verdict: "refused",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("setup flags follow the interface and a mismatched flag is help", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-claude-setup-flags-"));
  try {
    const file = join(root, "settings.json");
    const result = await dispatch(
      ["connection", "setup", "--interface", "claude-cli", "--hooks-file", file],
      { rootDir: root, onOutput: () => {} },
    );
    expect(result.kind).toBe("help");
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the Claude hook CLI reports committed commands to the model and notices to the person", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-claude-hook-cli-"));
  try {
    const output: string[] = [];
    const run = (
      result: Awaited<ReturnType<typeof import("../../src/cli/hooks/claude.js").runClaudeHook>>,
    ) =>
      dispatch(["_claude-hook", "--root", root], {
        claudeHookFn: async () => result,
        onOutput: (line) => output.push(line),
        readStdinFn: async () => "{}",
      });
    expect(await run({ context: "Lucid results:\nok", kind: "committed" })).toEqual({
      kind: "claude-hook",
    });
    expect(JSON.parse(output.pop() ?? "null")).toEqual({
      hookSpecificOutput: { additionalContext: "Lucid results:\nok", hookEventName: "PostToolUse" },
    });
    await run({ kind: "notice", message: "Stopped" });
    expect(JSON.parse(output.pop() ?? "null")).toEqual({ systemMessage: "Stopped" });
    await run({ kind: "skipped" });
    expect(output).toEqual([]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
