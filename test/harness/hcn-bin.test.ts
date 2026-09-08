/**
 * Which hcn actually runs.
 *
 * The order is LUCID_HCN, then the package-local bin, then PATH. The
 * package-local lookup happens twice, and the second one exists because
 * `import.meta.url` inside a `bun build --compile` executable points into
 * the embedded filesystem: a path resolved from it names something that
 * cannot exist, so a built binary fell straight through to PATH and used
 * whatever hcn was installed globally.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHcnBin } from "../../src/harness/node-deps.js";
import { HarnessVersionError } from "../../src/harness/runner.js";

let root: string;

// Every lookup is injected, so nothing here touches the process's own cwd
// or environment. A test that changed either would reach into every other
// test file in the run.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lucid-hcnbin-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolving the hcn binary", () => {
  /** A module directory with no package-local bin under it — which is what
   * a built binary always has, since its modules live inside the
   * executable. */
  const noBesideBin = (): string => join(root, "embedded", "src", "harness");

  test("LUCID_HCN wins over everything", () => {
    expect(resolveHcnBin({ env: "/somewhere/else/hcn" })).toEqual({
      bin: "/somewhere/else/hcn",
      source: "env",
    });
  });

  test("an empty LUCID_HCN is not a choice", () => {
    expect(resolveHcnBin({ env: "", moduleDir: noBesideBin(), cwd: root }).source).not.toBe("env");
  });

  test("a package-local bin beside the module is used", () => {
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "hcn"), "#!/bin/sh\n");
    const got = resolveHcnBin({ moduleDir: join(root, "src", "harness"), cwd: "/" });
    expect(got.bin).toBe(join(bin, "hcn"));
    expect(got.source).toBe("node_modules");
  });

  test("with none beside the module, a node_modules beside the cwd is used", () => {
    // The case a built binary is in, and the one that was broken: the
    // lookup beside the module can never hit, so without this it fell
    // through to PATH and used whatever hcn was installed globally.
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "hcn"), "#!/bin/sh\n");
    const got = resolveHcnBin({ moduleDir: noBesideBin(), cwd: root });
    expect(got.bin).toBe(join(bin, "hcn"));
    expect(got.source).toBe("node_modules(cwd)");
  });

  test("an npm install resolves its hoisted dependency outside the working folder", () => {
    const dependency = join(root, "node_modules", "@dungle-scrubs", "harness-cli-normalizer");
    mkdirSync(join(dependency, "dist"), { recursive: true });
    writeFileSync(
      join(dependency, "package.json"),
      JSON.stringify({ name: "@dungle-scrubs/harness-cli-normalizer" }),
    );
    writeFileSync(join(dependency, "dist", "cli.js"), "#!/usr/bin/env node\n");
    const moduleDir = join(root, "node_modules", "@dungle-scrubs", "lucid", "dist", "package");
    expect(resolveHcnBin({ moduleDir, cwd: "/" })).toEqual({
      bin: join(dependency, "dist", "cli.js"),
      source: "package-dependency",
    });
  });

  test("a compiled binary finds its checkout dependency from another working folder", () => {
    const bin = join(root, "node_modules", ".bin", "hcn");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");
    expect(
      resolveHcnBin({
        moduleDir: "/$bunfs/root",
        executablePath: join(root, "dist", "lucid"),
        cwd: "/",
      }),
    ).toEqual({ bin, source: "node_modules(executable)" });
  });

  test("with nothing local, it falls to PATH", () => {
    expect(resolveHcnBin({ moduleDir: noBesideBin(), cwd: join(root, "empty") })).toEqual({
      bin: "hcn",
      source: "path",
    });
  });
});

describe("the version refusal says where the binary came from", () => {
  test("naming the binary, so the advice points at the right place", () => {
    const e = new HarnessVersionError("0.5.3", "0.5.4", "/opt/homebrew/bin/hcn");
    // "run bun install" would have fixed nothing when the binary came from
    // Homebrew, which is exactly the case that found this.
    expect(e.message).toContain("/opt/homebrew/bin/hcn");
    expect(e.message).toContain("LUCID_HCN");
    expect(e.message).not.toContain("bun install");
  });

  test("without a binary it keeps the old wording", () => {
    expect(new HarnessVersionError("0.5.3", "0.5.4").message).toContain("bun install");
  });
});
