/**
 * The process primitives the hcn adapter needs, injected so tests drive a
 * scripted child instead of a real one.
 *
 * lucid used to borrow the normalizer's test fakes for this. That package
 * does not ship its `test/` tree, so the borrowed fakes broke on any install
 * that was not the neighbouring checkout. These are lucid's, and what they
 * fake is the `hcn` process: its argv, its stdin writes, its NDJSON stdout,
 * and its exit code.
 *
 * What it is NOT: it is not a harness fake. lucid no longer models claude's
 * stream-json or pi's rpc - hcn owns that, and lucid's fixtures are
 * recordings of hcn's output.
 */

export interface HcnProcess {
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  readonly exited: Promise<number | null>;
  write(line: string): void;
  endInput(): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type SpawnHcn = (argv: readonly string[], opts: { readonly cwd?: string }) => HcnProcess;

export interface HarnessDeps {
  readonly spawn: SpawnHcn;
  /** Absolute path to the hcn binary. */
  readonly bin: string;
  /** Structured boundary log, one line per transition. */
  readonly log?: (event: Record<string, unknown>) => void;
}
