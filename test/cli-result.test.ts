import { describe, expect, test } from "bun:test";
import { CliFailure, interpretCliResult } from "./e2e/cli-result.ts";

const ok = {
  argv: ["open", "plan.html"],
  code: 0,
  signal: null,
  stdout: '{"ok":true,"url":"http://127.0.0.1:17412/"}',
  stderr: "",
};

describe("interpretCliResult", () => {
  test("returns the parsed document when the CLI behaved", () => {
    expect(interpretCliResult(ok)).toEqual({ ok: true, url: "http://127.0.0.1:17412/" });
  });

  test("a non-zero exit throws carrying everything needed to diagnose it", () => {
    // The whole point of the capability. `execFile` rejects with a message like
    // "Command failed" and drops argv, the exit code, and stderr on the floor,
    // so a red test tells you a CLI call failed and nothing about which one or
    // why - and the answer is usually sitting in the stderr that was discarded.
    let thrown: unknown;
    try {
      interpretCliResult({ ...ok, code: 2, stdout: "", stderr: "no such artifact" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliFailure);
    const failure = thrown as CliFailure;
    expect(failure.argv).toEqual(["open", "plan.html"]);
    expect(failure.code).toBe(2);
    expect(failure.stderr).toBe("no such artifact");
    // And the message alone has to be enough, because that is all a CI log shows.
    expect(failure.message).toContain("open plan.html");
    expect(failure.message).toContain("exit 2");
    expect(failure.message).toContain("no such artifact");
  });

  test("exit 0 with non-JSON stdout fails DISTINCTLY, not as a parse error", () => {
    // The failure this capability exists to name. An Effect CommandMismatch
    // prints a log block to stdout and exits 0, so every agent doing
    // JSON.parse(stdout) gets "Unexpected token" - a message about the parser,
    // pointing at the test, when the defect is in the CLI's contract. M2.1
    // fixes the CLI; this makes the harness say which of the two it is.
    let thrown: unknown;
    try {
      interpretCliResult({ ...ok, stdout: 'timestamp=... level=INFO message="oops"' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliFailure);
    const failure = thrown as CliFailure;
    expect(failure.code).toBe(0);
    expect(failure.message).toContain("exit 0 but stdout is not JSON");
    // The offending output has to travel with it - otherwise the next question
    // is "what did it print?" and the answer is gone.
    expect(failure.message).toContain("level=INFO");
  });

  test("a killed process names the signal rather than reporting exit null", () => {
    // kill-server SIGKILLs a session mid-turn on purpose, so this is a normal
    // outcome in that suite and needs to read as one.
    let thrown: unknown;
    try {
      interpretCliResult({ ...ok, code: null, signal: "SIGKILL", stdout: "" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as CliFailure).signal).toBe("SIGKILL");
    expect((thrown as CliFailure).message).toContain("killed by SIGKILL");
  });

  test("an empty stdout on success is a failure, not an empty object", () => {
    // A server that died between accepting the command and printing would
    // otherwise look like a successful no-op.
    expect(() => interpretCliResult({ ...ok, stdout: "" })).toThrow(CliFailure);
  });
});
