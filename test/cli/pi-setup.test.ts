import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.js";
import { selfInvocation } from "../../src/cli/invocation.js";
import { piExtensionSource } from "../../src/harness/pi-extension.js";

const cli = (file: string, json = true) => [
  "connection",
  "setup",
  "--interface",
  "pi-cli",
  "--settings-file",
  file,
  ...(json ? ["--json"] : []),
];

test("Pi setup creates a missing settings file with the extension at mode 0600", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-setup-new-"));
  try {
    const file = join(root, "agent", "settings.json");
    const output: string[] = [];
    const deps = { rootDir: join(root, "records"), onOutput: (line: string) => output.push(line) };
    expect(await dispatch(cli(file), deps)).toEqual({
      kind: "connection-setup",
      verdict: "installed",
    });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved)).toEqual(["extensions"]);
    expect(saved.extensions).toHaveLength(1);
    expect(typeof saved.extensions[0]).toBe("string");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    const entry = JSON.parse(output.pop() ?? "null");
    expect(entry).toMatchObject({ ready: false, status: "installed", trustRequired: true });
    expect(entry.hooksFile).toBe(file);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Pi setup preserves existing keys and other extensions in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-setup-keep-"));
  try {
    const file = join(root, "settings.json");
    const other = join(root, "other-extension.js");
    writeFileSync(other, "export default function () {}");
    writeFileSync(file, JSON.stringify({ extensions: [other], theme: "dark" }), { mode: 0o644 });
    expect(
      await dispatch(cli(file), { rootDir: join(root, "records"), onOutput: () => {} }),
    ).toMatchObject({ verdict: "installed" });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.theme).toBe("dark");
    expect(saved.extensions).toEqual([other, saved.extensions[1]]);
    expect(lstatSync(file).mode & 0o777).toBe(0o644);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a second Pi setup run is unchanged and writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-setup-twice-"));
  try {
    const file = join(root, "settings.json");
    const deps = { rootDir: join(root, "records"), onOutput: () => {} };
    expect(await dispatch(cli(file), deps)).toMatchObject({ verdict: "installed" });
    const bytes = readFileSync(file, "utf8");
    const before = lstatSync(file);
    expect(await dispatch(cli(file), deps)).toEqual({
      kind: "connection-setup",
      verdict: "unchanged",
    });
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(lstatSync(file).mtimeMs).toBe(before.mtimeMs);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Pi setup replaces an older Lucid entry under the same root and keeps one under another root", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-setup-swap-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "lucid-pi-setup-other-"));
  try {
    const file = join(root, "settings.json");
    const records = join(root, "records");
    const stale = join(records, ".integrations", "pi", "lucid-0000000000000000.js");
    const elsewhere = join(otherRoot, ".integrations", "pi", "lucid-ffffffffffffffff.js");
    const foreign = join(otherRoot, "someone-elses.js");
    writeFileSync(file, JSON.stringify({ extensions: [stale, elsewhere, foreign] }));
    expect(await dispatch(cli(file), { rootDir: records, onOutput: () => {} })).toMatchObject({
      verdict: "installed",
    });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.extensions).toHaveLength(3);
    expect(saved.extensions.slice(0, 2)).toEqual([elsewhere, foreign]);
    expect(saved.extensions[2]).not.toBe(stale);
    expect(saved.extensions[2].startsWith(join(records, ".integrations", "pi", "lucid-"))).toBe(
      true,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(otherRoot, { force: true, recursive: true });
  }
});

test("invalid Pi settings refuse settings-invalid and leave the bytes unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-setup-invalid-"));
  try {
    const file = join(root, "settings.json");
    const deps = { rootDir: join(root, "records"), onOutput: () => {} };
    for (const bytes of ['{"extensions":', "[]", '{"extensions":"x"}', '{"extensions":[1]}']) {
      writeFileSync(file, bytes);
      const output: string[] = [];
      expect(
        await dispatch(cli(file), { ...deps, onOutput: (line: string) => output.push(line) }),
      ).toEqual({ kind: "connection-setup", verdict: "refused" });
      expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
        reason: "settings-invalid",
        status: "refused",
      });
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the written extension file exists and pins the record root and the lucid command", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-setup-file-"));
  try {
    const file = join(root, "settings.json");
    const records = join(root, "records");
    expect(await dispatch(cli(file), { rootDir: records, onOutput: () => {} })).toMatchObject({
      verdict: "installed",
    });
    const path = JSON.parse(readFileSync(file, "utf8")).extensions[0];
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).toBe(piExtensionSource({ command: selfInvocation([]), root: records }));
    for (const part of selfInvocation([])) expect(source).toContain(part);
    expect(source).toContain(records);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Pi setup flags follow the interface and a mismatched flag is help", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-setup-flags-"));
  try {
    const file = join(root, "settings.json");
    const result = await dispatch(
      ["connection", "setup", "--interface", "pi-cli", "--hooks-file", file],
      { rootDir: root, onOutput: () => {} },
    );
    expect(result.kind).toBe("help");
    expect(existsSync(file)).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
