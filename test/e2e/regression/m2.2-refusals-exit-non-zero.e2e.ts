import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { makeCli, type Cli } from "../helpers.ts";

/**
 * M2.2 - a refusal exits non-zero.
 *
 * `progress` and `context` printed `{ok:false, error:"..."}` and exited **0**.
 * Every shell that guards on a command - `if lucid progress …; then` - read a
 * no-op as success, and every agent checking an exit code before parsing saw
 * nothing wrong. The refusal was visible only to a reader who happened to look
 * at the JSON, which is the one audience that did not need telling.
 *
 * A refusal exits non-zero and answers in the same `{error:{code,message}}`
 * envelope as everything else, so `ok:false` stops being a second, quieter
 * dialect for failure.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const raw = async (
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = spawn("bun", ["run", "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, LUCID_NO_OPEN: "1" },
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number>((resolve) => proc.once("close", (c) => resolve(c ?? 0)));
  return { code, stdout, stderr };
};

test("progress and context refuse with a non-zero exit, not a quiet ok:false", async () => {
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");

  const refusals: ReadonlyArray<{ what: string; args: readonly string[] }> = [
    { what: "progress with no label, total or done", args: ["progress", cli.artifact] },
    { what: "context with no pct and no used/total", args: ["context", cli.artifact] },
  ];

  const wrong: string[] = [];
  for (const { what, args } of refusals) {
    const result = await raw(args);
    if (result.code === 0) {
      wrong.push(`${what}: exited 0 - a shell \`if\` reads this refusal as success`);
      continue;
    }
    // And it refuses in the one dialect the contract has.
    const parsed = JSON.parse(result.stdout) as {
      ok?: boolean;
      error?: { code?: string; message?: string } | string;
    };
    if (typeof parsed.error === "string" || !parsed.error?.code) {
      wrong.push(`${what}: exited ${result.code} but answered in the old ok:false shape`);
    }
  }

  expect(wrong, `refusals that a caller cannot detect:\n  ${wrong.join("\n  ")}`).toEqual([]);
});

test("a command that succeeds still exits 0", async () => {
  // The control. Making refusals loud is worthless if it also makes successes
  // look like failures, and a test that only ever checks the sad path would
  // not notice.
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");
  await cli.run(["open", cli.artifact]);

  const result = await raw(["progress", cli.artifact, "--label", "backfilling"]);
  expect(result.code, `a valid progress call exited ${result.code}: ${result.stdout}`).toBe(0);
});
