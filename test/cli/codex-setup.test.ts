import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.js";
import { acquireAppendLock } from "../../src/store/flock.js";

test("Codex setup preserves unrelated hooks and repeating it leaves the file unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-setup-"));
  try {
    const file = join(root, "hooks.json");
    const existing = {
      description: "Existing hooks",
      hooks: {
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "printf existing-start" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "printf existing-stop", timeout: 12 }] }],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "printf existing-policy" }] },
        ],
      },
    };
    writeFileSync(file, JSON.stringify(existing));
    const output: string[] = [];
    const deps = { rootDir: join(root, "records"), onOutput: (line: string) => output.push(line) };
    const argv = [
      "connection",
      "setup",
      "--interface",
      "codex-cli",
      "--hooks-file",
      file,
      "--json",
    ];
    expect(await dispatch(argv, deps)).toEqual({ kind: "connection-setup", verdict: "installed" });
    const result = JSON.parse(output.pop() ?? "null");
    expect(result).toMatchObject({ status: "installed", trustRequired: true, ready: false });
    const bytes = readFileSync(file, "utf8");
    const saved = JSON.parse(bytes);
    expect(saved.description).toBe(existing.description);
    expect(saved.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(saved.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
    expect(saved.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    expect(saved.hooks.SessionStart).toHaveLength(2);
    expect(saved.hooks.SessionStart[1].hooks[0]).toMatchObject({
      timeout: 60,
      statusMessage: "Preparing this session for Lucid feedback",
    });
    expect(saved.hooks.Stop).toHaveLength(2);
    expect(saved.hooks.Stop[1].hooks[0]).toMatchObject({
      timeout: 60,
      statusMessage: "Listening for Lucid feedback (up to 45 seconds)",
    });
    expect(saved.hooks.Interrupt[0].hooks[0].timeout).toBe(3);
    expect(await dispatch(argv, deps)).toEqual({ kind: "connection-setup", verdict: "unchanged" });
    expect(readFileSync(file, "utf8")).toBe(bytes);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Codex setup treats a missing hooks file argument as help without touching configuration", async () => {
  let opened = false;
  const result = await dispatch(
    ["connection", "setup", "--interface", "codex-cli", "--hooks-file", "--json"],
    {
      conversationsFactory: () => {
        opened = true;
        throw new Error("No configuration expected");
      },
      onOutput: () => {},
    },
  );
  expect(result.kind).toBe("help");
  expect(opened).toBe(false);
});

test("Codex setup refuses a deployed symlink and leaves its source and link untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-setup-link-"));
  try {
    const source = join(root, "managed-hooks.json");
    const target = join(root, "hooks.json");
    const bytes = '{"description":"Managed source","hooks":{}}\n';
    writeFileSync(source, bytes);
    symlinkSync(source, target);
    expect(
      await dispatch(
        ["connection", "setup", "--interface", "codex-cli", "--hooks-file", target, "--json"],
        { rootDir: root, onOutput: () => {} },
      ),
    ).toEqual({ kind: "connection-setup", verdict: "refused" });
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(source, "utf8")).toBe(bytes);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Codex setup refuses changed or duplicate Lucid handlers without rewriting them", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-setup-conflict-"));
  try {
    const file = join(root, "hooks.json");
    writeFileSync(file, '{"hooks":{}}');
    const argv = [
      "connection",
      "setup",
      "--interface",
      "codex-cli",
      "--hooks-file",
      file,
      "--json",
    ];
    const deps = { rootDir: root, onOutput: () => {} };
    expect(await dispatch(argv, deps)).toMatchObject({ verdict: "installed" });
    const installed = readFileSync(file, "utf8");
    for (const change of ["async", "timeout", "duplicate", "matcher", "command"]) {
      const config = JSON.parse(installed);
      const group = config.hooks.Stop[0];
      if (change === "async") group.hooks[0].async = true;
      if (change === "timeout") group.hooks[0].timeout = 1;
      if (change === "duplicate") config.hooks.Stop.push(structuredClone(group));
      if (change === "matcher") config.hooks.SessionStart[0].matcher = "startup";
      if (change === "command") group.hooks[0].command = "old-lucid _codex-hook";
      const bytes = JSON.stringify(config);
      writeFileSync(file, bytes);
      expect(await dispatch(argv, deps)).toEqual({ kind: "connection-setup", verdict: "refused" });
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Codex setup creates a missing configuration and keeps malformed existing bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-setup-new-"));
  try {
    const file = join(root, "project", ".codex", "hooks.json");
    const argv = [
      "connection",
      "setup",
      "--interface",
      "codex-cli",
      "--hooks-file",
      file,
      "--json",
    ];
    const deps = { rootDir: root, onOutput: () => {} };
    expect(await dispatch(argv, deps)).toMatchObject({ verdict: "installed" });
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).hooks)).toEqual([
      "SessionStart",
      "Stop",
      "Interrupt",
    ]);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    const invalid = '{"hooks":';
    writeFileSync(file, invalid);
    expect(await dispatch(argv, deps)).toMatchObject({ verdict: "refused" });
    expect(readFileSync(file, "utf8")).toBe(invalid);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Codex setup leaves configuration untouched while another setup owns its lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-setup-busy-"));
  const file = join(root, "hooks.json");
  const bytes = '{"hooks":{}}';
  writeFileSync(file, bytes);
  const lock = acquireAppendLock(`${file}.lucid-setup`, { privateFile: true, timeoutMs: 0 });
  try {
    const argv = [
      "connection",
      "setup",
      "--interface",
      "codex-cli",
      "--hooks-file",
      file,
      "--json",
    ];
    const output: string[] = [];
    const deps = { rootDir: root, onOutput: (line: string) => output.push(line) };
    expect(await dispatch(argv, deps)).toMatchObject({ verdict: "refused" });
    expect(JSON.parse(output.pop() ?? "null").reason).toBe("hooks-busy");
    expect(readFileSync(file, "utf8")).toBe(bytes);
    lock.release();
    expect(await dispatch(argv, deps)).toMatchObject({ verdict: "installed" });
  } finally {
    lock.release();
    rmSync(root, { force: true, recursive: true });
  }
});

test("generated Codex hooks preserve literal shell arguments and select the configured record root", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-setup-argv-"));
  try {
    const recordRoot = join(root, "records 'quoted' $(touch INJECTED)");
    const file = join(root, "hooks.json");
    expect(
      await dispatch(
        ["connection", "setup", "--interface", "codex-cli", "--hooks-file", file, "--json"],
        { rootDir: recordRoot, onOutput: () => {} },
      ),
    ).toMatchObject({ verdict: "installed" });
    const hooks = JSON.parse(readFileSync(file, "utf8")).hooks;
    for (const event of ["SessionStart", "Stop", "Interrupt"]) {
      const command = hooks[event][0].hooks[0].command;
      const shell = Bun.spawnSync(
        [
          "/bin/sh",
          "-c",
          `set -- ${command}; exec "$1" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "$@"`,
        ],
        { cwd: root },
      );
      expect(shell.exitCode).toBe(0);
      const args: string[] = JSON.parse(shell.stdout.toString());
      expect(args.slice(-3)).toEqual(["_codex-hook", "--root", recordRoot]);
      expect(existsSync(join(root, "INJECTED"))).toBe(false);
      let selectedRoot: string | undefined;
      await dispatch(args.slice(-3), {
        rootDir: join(root, "wrong-root"),
        readStdinFn: async () => JSON.stringify({ hook_event_name: "SubagentStop" }),
        codexHookFn: async (records) => {
          selectedRoot = records.rootDir;
          return { kind: "skipped" };
        },
      });
      expect(selectedRoot).toBe(recordRoot);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
