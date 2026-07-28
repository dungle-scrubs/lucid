import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { harnessEnv } from "../harness-env.ts";
import { MAIN, makeCli, type Cli } from "../helpers.ts";

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
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  // `harnessEnv`, not a hand-rolled `{...process.env}`. Spelling the env out
  // here inherited every name M0.4 exists to contain: a run from an agent
  // session that had used Lucid stamped the artifact with the DEVELOPER's
  // harness and their real session UUID, and left hub discovery unpinned.
  // `test/env-isolation.test.ts` audits `harnessEnv` and the unit suite, so it
  // cannot see an e2e file that declines to use it.
  const proc = spawn("bun", [MAIN, ...args], {
    cwd,
    env: harnessEnv(cwd),
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
    const result = await raw(cli.dir, args);
    if (result.code === 0) {
      wrong.push(`${what}: exited 0 - a shell \`if\` reads this refusal as success`);
      continue;
    }
    // And it refuses in the one dialect the contract has.
    let parsed: { ok?: boolean; error?: { code?: string; message?: string } | string };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      // Named rather than thrown as `Unexpected end of JSON input`, which
      // points at this line instead of at the CLI.
      wrong.push(
        `${what}: exited ${result.code} but stdout was not JSON: ${result.stdout.slice(0, 80)}`,
      );
      continue;
    }
    if (typeof parsed.error === "string" || !parsed.error?.code) {
      wrong.push(`${what}: exited ${result.code} but answered in the old ok:false shape`);
    }
  }

  expect(wrong, `refusals that a caller cannot detect:\n  ${wrong.join("\n  ")}`).toEqual([]);
});

test("context --used with no --total refuses in the same envelope as progress and ask", async () => {
  // The arm the first test cannot reach. `context` with NOTHING is refused by
  // the same `if (!clean)` branch as any other empty report, so it proves only
  // that the branch exists. `--used 142000` with no `--total` is a report the
  // caller believes it made: a number went in, `sanitizeContext` can derive no
  // fill fraction from a numerator alone, and the whole thing is dropped. That
  // is the shape an agent actually types, and the one where a silent exit 0
  // would mean a ring that never appears and a script that never notices.
  //
  // "Uniform" is the other half of the claim, so three commands that refuse for
  // three different reasons are read together: a half-report, a count that
  // sanitizes away to nothing, and an `ask` against a session that was never
  // opened. One dialect - non-zero out, `{error:{code,message}}` on stdout - or
  // a caller needs a different check per subcommand.
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");
  // The session DIRECTORY, without paying for a server.
  //
  // Not decoration - without it this test cannot see the defect it is about.
  // `context` writes its sidecar into `<dir>/<stem>/`, so on a bare artifact a
  // build whose validation had been broken still exits non-zero: it gets past
  // the refusal and dies on ENOENT instead, in the same envelope, and the test
  // passes for a reason that has nothing to do with the claim. With the
  // directory there, validation is the ONLY thing between this half-report and
  // an exit 0 - which is what makes a red here mean what it says. Measured:
  // deriving pct from `used` alone exits 0 with the directory, 1 without.
  await mkdir(join(cli.dir, "plan"), { recursive: true });

  const refusals: ReadonlyArray<{ what: string; args: readonly string[] }> = [
    { what: "context --used with no --total", args: ["context", cli.artifact, "--used", "142000"] },
    { what: "progress --done -3", args: ["progress", cli.artifact, "--done", "-3"] },
    { what: "ask with no text", args: ["ask", cli.artifact] },
  ];

  // Concurrently: three `bun` starts in series is most of this test's cost, and
  // nothing here shares state - each invocation only reads the artifact.
  const results = await Promise.all(
    refusals.map(async ({ what, args }) => ({ what, ...(await raw(cli.dir, args)) })),
  );

  const wrong: string[] = [];
  for (const { what, code, stdout } of results) {
    if (code === 0) {
      wrong.push(`${what}: exited 0 - a shell \`if\` reads this refusal as success`);
      continue;
    }
    let parsed: { ok?: boolean; error?: { code?: string; message?: string } | string };
    try {
      parsed = JSON.parse(stdout) as typeof parsed;
    } catch {
      wrong.push(`${what}: exited ${code} but stdout was not JSON: ${stdout.slice(0, 80)}`);
      continue;
    }
    if (typeof parsed.error === "string" || !parsed.error?.code || !parsed.error.message) {
      wrong.push(
        `${what}: exited ${code} but not in the {error:{code,message}} envelope: ${stdout.slice(0, 80)}`,
      );
    }
  }

  expect(wrong, `refusals a caller cannot detect uniformly:\n  ${wrong.join("\n  ")}`).toEqual([]);
});

test("a command that succeeds still exits 0", async () => {
  // The control. Making refusals loud is worthless if it also makes successes
  // look like failures, and a test that only ever checks the sad path would
  // not notice.
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");
  await cli.run(["open", cli.artifact]);

  const result = await raw(cli.dir, ["progress", cli.artifact, "--label", "backfilling"]);
  expect(result.code, `a valid progress call exited ${result.code}: ${result.stdout}`).toBe(0);
});
