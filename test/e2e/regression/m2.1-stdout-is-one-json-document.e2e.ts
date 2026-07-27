import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { harnessEnv } from "../harness-env.ts";
import { MAIN, makeCli, type Cli } from "../helpers.ts";

/**
 * M2.1 - stdout carries one JSON document, or nothing.
 *
 * This is the contract every agent integrates against: run a command, parse
 * stdout, read a typed error. Effect's CLI answers a bad subcommand or a bad
 * argument by LOGGING to stdout:
 *
 *     [16:59:59] ERROR (#17):
 *       Error: {"_tag":"CommandMismatch","error":{...}}
 *
 * so `JSON.parse(stdout)` throws on a line about the parser, pointing at the
 * caller's own code, when the CLI in fact refused for a reason it could have
 * named. The failure is not that the message is unhelpful - it is that the one
 * guarantee the contract makes is broken for a whole class of refusals.
 *
 * Not a unit test, because the defect lives in what the PROCESS writes to fd 1:
 * a test that called the handler directly would never see the logger.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

/** stdout, stderr and the code, with nothing interpreted - the raw contract. */
const raw = async (
  cwd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  // Playwright's runner is Node, not Bun - `Bun.spawn` is not defined here.
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

test("a refused command puts one JSON envelope on stdout", async () => {
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");

  const cases: ReadonlyArray<{ what: string; args: readonly string[] }> = [
    { what: "an unknown subcommand", args: ["bogus"] },
    { what: "an argument outside its allowed set", args: ["intent", cli.artifact, "maybe"] },
    { what: "a missing required option", args: ["wait"] },
    // The one command that had its own dialect: `lucid plan` with no
    // subcommand printed usage to stdout and exited 0, which is both defects
    // this milestone fixed, in the command neither path went through.
    { what: "a parent command with no subcommand", args: ["plan"] },
  ];

  const broken: string[] = [];
  for (const { what, args } of cases) {
    const result = await raw(cli.dir, args);
    const out = result.stdout.trim();

    if (out === "") {
      // The catalogue's scenario allows "empty OR one envelope". This CLI
      // implements the envelope, always, and asserting what it implements is
      // what makes the row provable: while empty counted as a pass, removing
      // the envelope left stdout silent and the test green - a mutation that
      // deletes the fix has to be able to fail.
      broken.push(`${what}: refused with nothing on stdout - a caller has no typed reason to read`);
      continue;
    }
    try {
      const parsed = JSON.parse(out) as { error?: { code?: string; message?: string } };
      // One document, and the shape an agent is told to expect.
      if (!parsed.error?.code || !parsed.error?.message) {
        broken.push(
          `${what}: parsed, but not an {error:{code,message}} envelope: ${out.slice(0, 120)}`,
        );
      }
    } catch {
      broken.push(`${what}: stdout is not JSON - ${out.split("\n")[0]?.slice(0, 120)}`);
    }
  }

  expect(broken, `stdout broke its contract:\n  ${broken.join("\n  ")}`).toEqual([]);
});

test("a refusal still says why, in words, and exits non-zero", async () => {
  // The other half: moving the noise off stdout must not make the CLI silent.
  // A refusal nobody can read is not an improvement on one nobody can parse.
  //
  // It does NOT echo the rejected token - `lucid bogus` answers "Invalid
  // subcommand for lucid - use one of ...", naming the valid set rather than
  // what was typed. Asserted as it is rather than as it might ideally be: an
  // assertion written for the better message would have failed against a CLI
  // that is behaving correctly.
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");
  const result = await raw(cli.dir, ["bogus"]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Invalid subcommand");
  // And the machine-readable half carries the same words, so the two channels
  // cannot drift into telling different stories.
  const envelope = JSON.parse(result.stdout) as { error: { code: string; message: string } };
  expect(envelope.error.code).toBe("USAGE");
  expect(result.stderr).toContain(envelope.error.message.split(" - ")[0] ?? "");
});

test("help, version and completions are answers, and are left alone", async () => {
  // The contract is "stdout is one JSON document" for anything that is asked to
  // DO something. An explicit request for help, a version or a completion
  // script is asked for text, and gets text - enumerated here rather than left
  // as an unstated exception to an unqualified promise.
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");

  for (const args of [["--help"], ["--version"], ["plan", "render", "--help"]]) {
    const result = await raw(cli.dir, args);
    expect(result.code, `${args.join(" ")} exited ${result.code}`).toBe(0);
    expect(result.stdout.trim().length, `${args.join(" ")} printed nothing`).toBeGreaterThan(0);
  }
});
