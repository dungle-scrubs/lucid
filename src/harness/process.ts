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
  readonly inputError?: Promise<void>;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  readonly exited: Promise<number | null>;
  write(line: string): void;
  endInput(): void;
  /** End pending output reads during terminal cleanup. */
  disposeOutput(): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type SpawnHcn = (argv: readonly string[], opts: { readonly cwd?: string }) => HcnProcess;

export interface HarnessDeps {
  readonly spawn: SpawnHcn;
  /** Grace before escalating a refused child from SIGTERM to SIGKILL. */
  readonly refusalGraceMs?: number;
  /** Context-accounting wall-clock ceiling, including native probe cleanup. */
  readonly accountingTimeoutMs?: number;
  /** Inspection commands cannot hold source startup indefinitely. */
  readonly inspectionTimeoutMs?: number;
  /** Absolute path to the hcn binary. */
  readonly bin: string;
  /** Structured boundary log, one line per transition. */
  readonly log?: (event: Record<string, unknown>) => void;
}

export const flag = (name: string, value: string | undefined): string[] =>
  value === undefined ? [] : [name, value];

/** One escalation policy. The caller chooses whether process exit or its
 * output pump is the terminal evidence it needs to await. */
export async function terminateHcn(
  proc: HcnProcess,
  graceMs: number,
  settled: Promise<unknown> = proc.exited,
): Promise<boolean> {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* Exit race. */
  }
  if (await settlesWithin(settled, graceMs)) return false;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* Exit race. */
  }
  return true;
}

export async function settlesWithin(work: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
