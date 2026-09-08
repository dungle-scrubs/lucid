import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { requestBackgroundWorker } from "../../src/cli/background-worker.js";
import { BACKGROUND_COMMAND } from "../../src/cli/invocation.js";

test("a managed worker cannot recursively launch another worker", () => {
  const previous = env[BACKGROUND_COMMAND];
  try {
    env[BACKGROUND_COMMAND] = "_managed-worker";
    expect(() =>
      requestBackgroundWorker(["_managed-worker", "root", "id", "input"], "root"),
    ).toThrow("A background worker cannot launch another background worker");
  } finally {
    if (previous === undefined) delete env[BACKGROUND_COMMAND];
    else env[BACKGROUND_COMMAND] = previous;
  }
});

test("compiled worker commands route directly to their internal subcommand", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-compiled-routing-"));
  const binary = join(root, "routing-probe");
  try {
    await Bun.build({
      compile: { autoloadBunfig: false, autoloadDotenv: false, outfile: binary },
      entrypoints: [resolve(import.meta.dir, "../helpers/compiled-routing.ts")],
      throw: true,
    });
    // The probe only prints argv. It cannot launch workers or a server.
    const child = Bun.spawn([binary], { stderr: "pipe", stdout: "pipe", timeout: 5000 });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const report = JSON.parse(output);
    expect(report.supervisor).toEqual([
      report.executable,
      "_hcn-supervise",
      "synthetic-hcn",
      "inspect",
      "claude",
    ]);
    expect(report.background).toEqual([
      report.executable,
      "_managed-worker",
      "synthetic-root",
      "conversation",
      "input",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}, 15000);
