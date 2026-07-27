/**
 * Turning a finished CLI invocation into either a document or a usable failure.
 *
 * Split out from the spawning so it can be tested without a process: the
 * interesting behaviour here is entirely about interpretation, and a test that
 * has to spawn `bun` to ask "what happens on exit 2" is slow and answers a
 * different question.
 *
 * The problem it solves: `execFile` rejects with `Command failed` and leaves
 * argv, the exit code and stderr on the floor. Two hundred tests calling the
 * CLI through that produce red runs that say a CLI call failed and nothing
 * about which one or why - while the answer sits in the stderr that was thrown
 * away. Retrofitting this later across every call site is a rewrite, so it
 * comes first (D-013).
 */

export interface CliOutcome {
  /** Arguments after the entrypoint, i.e. what the test asked for. */
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the runner killed it for exceeding `timeoutMs`. Carried
   *  separately because the kill arrives as a plain SIGTERM, indistinguishable
   *  from any other, and the two mean opposite things. */
  readonly killed?: boolean;
  readonly timeoutMs?: number;
}

/** Everything about a failed invocation, kept as fields rather than only prose
 *  so an assertion can reach the exit code without parsing a message. */
export class CliFailure extends Error {
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(summary: string, outcome: CliOutcome) {
    super(`lucid ${outcome.argv.join(" ")}: ${summary}${detail(outcome)}`);
    this.name = "CliFailure";
    this.argv = outcome.argv;
    this.code = outcome.code;
    this.signal = outcome.signal;
    this.stdout = outcome.stdout;
    this.stderr = outcome.stderr;
  }
}

/** Only the streams that have something in them, indented under the summary. */
const MAX_STREAM_CHARS = 2000;

/** `execFile` buffers up to a megabyte per stream, and the failure this exists
 *  to describe is often a CLI dumping a log block. Enough to diagnose, not
 *  enough to bury the rest of the CI log. */
const clip = (stream: string): string =>
  stream.length > MAX_STREAM_CHARS
    ? `${stream.slice(0, MAX_STREAM_CHARS)}… (+${stream.length - MAX_STREAM_CHARS} chars)`
    : stream;

const detail = (outcome: CliOutcome): string => {
  const parts: string[] = [];
  if (outcome.stderr.trim() !== "") parts.push(`  stderr: ${clip(outcome.stderr.trim())}`);
  if (outcome.stdout.trim() !== "") parts.push(`  stdout: ${clip(outcome.stdout.trim())}`);
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
};

/**
 * The document the CLI printed, or a failure that says what happened.
 *
 * The CLI's contract is one JSON document on stdout and a truthful exit code -
 * that is what an agent integrates against, so it is what the harness holds it
 * to.
 */
export const interpretCliResult = (outcome: CliOutcome): Record<string, unknown> => {
  // Timeout first. `execFile` enforces its deadline by sending SIGTERM, so a
  // hang and a deliberate signal arrive looking identical - and in this suite
  // both really happen, since kill-server SIGKILLs servers on purpose. Reporting
  // a timeout as "killed by SIGTERM" would assert the wrong cause in the one
  // place it matters most.
  if (outcome.killed === true) {
    const budget = outcome.timeoutMs === undefined ? "" : ` after ${outcome.timeoutMs}ms`;
    throw new CliFailure(
      `timed out${budget} (killed with ${outcome.signal ?? "SIGTERM"})`,
      outcome,
    );
  }
  if (outcome.signal !== null) {
    throw new CliFailure(`killed by ${outcome.signal}`, outcome);
  }
  if (outcome.code !== 0) {
    throw new CliFailure(`exit ${outcome.code}`, outcome);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    throw new CliFailure("exit 0 but stdout is not JSON", outcome);
  }
  // `null`, `3` and `[]` are all valid JSON and none of them is the document
  // the CLI contract promises. Letting them through would hand a test something
  // it would dereference into a confusing undefined three lines later.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliFailure("exit 0 but stdout is not a JSON object", outcome);
  }
  return parsed as Record<string, unknown>;
};
