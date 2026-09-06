/**
 * lucid's own fakes for the hcn process.
 *
 * These replaced the normalizer's test fakes, which lucid borrowed through
 * the file: alias. That package does not ship its `test/` tree, so the
 * borrowed fakes only worked against a neighbouring checkout.
 *
 * What these fake is the `hcn` child process, not a harness: argv, stdin
 * writes, NDJSON stdout, exit code. The bytes they emit are recordings of
 * real hcn output under test/fixtures/hcn.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HcnProcess, SpawnHcn } from "../../src/harness/process.js";
import type { ArtifactHost } from "../../src/modes/host.js";
import { ARTIFACT_BYTES_MAX } from "../../src/protocol/frames.js";
import { type ArtifactVersion, foldCollect, hashArtifactBytes } from "../../src/store/log.js";

export const FIXTURES = join(import.meta.dir, "..", "fixtures", "hcn");

/** Read a recorded hcn stdout stream. */
export const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.ndjson`), "utf8");

/** Every line of a recording, parsed. */
export const fixtureEvents = (name: string): Record<string, unknown>[] =>
  fixture(name)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

class Channel implements AsyncIterable<string> {
  private items: string[] = [];
  private closed = false;
  private wake: (() => void) | null = null;

  push(chunk: string): void {
    if (this.closed) return;
    this.items.push(chunk);
    const w = this.wake;
    this.wake = null;
    w?.();
  }
  close(): void {
    this.closed = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as string;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

export class FakeHcnProcess implements HcnProcess {
  readonly stdoutChannel = new Channel();
  readonly stderrChannel = new Channel();
  readonly writes: string[] = [];
  readonly signals: string[] = [];
  inputEnded = false;
  private exitResolve!: (code: number | null) => void;
  readonly exited: Promise<number | null>;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  get stdout(): AsyncIterable<string> {
    return this.stdoutChannel;
  }
  get stderr(): AsyncIterable<string> {
    return this.stderrChannel;
  }
  /** Commands the adapter wrote, one parsed object per line. */
  get commands(): Record<string, unknown>[] {
    return this.writes
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  write(line: string): void {
    if (this.inputEnded) throw new Error("write after end");
    this.writes.push(line);
  }
  endInput(): void {
    this.inputEnded = true;
  }
  kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    this.signals.push(signal);
    this.exit(null);
  }

  /** Emit one NDJSON line of hcn output. */
  emit(event: unknown): void {
    this.stdoutChannel.push(`${JSON.stringify(event)}\n`);
  }
  /** Emit a raw line, for malformed-input cases. */
  emitRaw(line: string): void {
    this.stdoutChannel.push(`${line}\n`);
  }
  /** Replay a whole recorded stream. */
  emitFixture(name: string): void {
    this.stdoutChannel.push(fixture(name));
  }
  exit(code: number | null): void {
    this.stdoutChannel.close();
    this.stderrChannel.close();
    this.exitResolve(code);
  }
}

export interface FakeSpawnRecord {
  readonly argv: readonly string[];
  readonly opts: { readonly cwd?: string };
  readonly proc: FakeHcnProcess;
}

/** A spawner handing out scripted processes in order. */
export const fakeSpawner = (procs: FakeHcnProcess[]) => {
  const calls: FakeSpawnRecord[] = [];
  let next = 0;
  const spawn: SpawnHcn = (argv, opts) => {
    const proc = procs[next++] ?? new FakeHcnProcess();
    calls.push({ argv, opts, proc });
    return proc;
  };
  return { spawn, calls };
};

/** In-memory artifact seam for source tests that do not exercise the durable store. */
export const fakeArtifactHost = (overrides: Partial<ArtifactHost> = {}): ArtifactHost => {
  const versions = new Map<string, Map<number, ArtifactVersion>>();
  let cursor = 0;
  const empty = foldCollect("fake", "fake-secret", Buffer.alloc(0));
  return {
    cursor: () => cursor,
    collectEffects: () => ({ ...empty, entries: empty.collected }),
    advanceCursor: (offset) => {
      cursor = Math.max(cursor, offset);
    },
    artifactHeads: () =>
      new Map([...versions].map(([id, values]) => [id, Math.max(...values.keys())])),
    readArtifact: (id, version) => versions.get(id)?.get(version) ?? null,
    writeArtifact: (params) => {
      if (params.bytes.length > ARTIFACT_BYTES_MAX)
        return { verdict: "refused", issue: "artifact-too-large" };
      const values = versions.get(params.artifactId) ?? new Map<number, ArtifactVersion>();
      const existing = values.get(params.version);
      if (existing !== undefined)
        return existing.bytes === params.bytes
          ? { verdict: "accepted", version: existing }
          : { verdict: "refused", issue: "artifact-version-exists" };
      const version = { ...params, at: 0, hash: hashArtifactBytes(params.bytes) };
      values.set(params.version, version);
      versions.set(params.artifactId, values);
      return { verdict: "accepted", version };
    },
    ...overrides,
  };
};
