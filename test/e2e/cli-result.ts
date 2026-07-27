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
const detail = (outcome: CliOutcome): string => {
  const parts: string[] = [];
  if (outcome.stderr.trim() !== "") parts.push(`  stderr: ${outcome.stderr.trim()}`);
  if (outcome.stdout.trim() !== "") parts.push(`  stdout: ${outcome.stdout.trim()}`);
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
  if (outcome.signal !== null) {
    throw new CliFailure(`killed by ${outcome.signal}`, outcome);
  }
  if (outcome.code !== 0) {
    throw new CliFailure(`exit ${outcome.code}`, outcome);
  }
  try {
    return JSON.parse(outcome.stdout) as Record<string, unknown>;
  } catch {
    throw new CliFailure("exit 0 but stdout is not JSON", outcome);
  }
};
