import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpawn } from "../src/launch/spawn.ts";

/**
 * A spawned turn that goes silent must be killed, not waited on forever.
 *
 * `runSpawn` awaited `proc.exited` with no bound, and the attend engine treats
 * a live child as a delivery in flight - so one wedged process silently queued
 * every later piece of feedback behind it while the panel still reported an
 * older turn as the live one. Measured on a real session: 53 minutes, no
 * output, six pieces of feedback undelivered.
 *
 * The bound is on SILENCE, never on duration: a turn that is working writes
 * progress, prose or errors, and must be allowed to take as long as it takes.
 */
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-stall-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const script = async (name: string, body: string): Promise<string> => {
  const exe = join(dir, name);
  await writeFile(exe, `#!/bin/sh\n${body}\n`);
  await chmod(exe, 0o755);
  return exe;
};

describe("a wedged turn", () => {
  test("is killed once it has written nothing for the idle window", async () => {
    // Writes one line, then hangs forever - the shape of the real wedge.
    const exe = await script("wedged", 'printf "started\\n"\nsleep 600');
    const log = join(dir, "out.log");
    const started = Date.now();
    const result = await runSpawn([exe], dir, log, undefined, { idleMs: 1_000 });
    const elapsed = Date.now() - started;

    // It came back at all - the assertion the old code could not satisfy.
    expect(result.status).toBe("process-failed");
    expect(result.code).not.toBe(0);
    // ...promptly, rather than after the child's own 600s.
    expect(elapsed).toBeLessThan(30_000);
  }, 40_000);

  test("a turn that keeps writing is left alone", async () => {
    // Silent for longer than the window between writes would be a false
    // positive; this one keeps talking, so it must finish on its own terms.
    const exe = await script(
      "chatty",
      'i=0\nwhile [ $i -lt 6 ]; do printf "working %s\\n" "$i"; sleep 0.3; i=$((i+1)); done\nexit 0',
    );
    const result = await runSpawn([exe], dir, join(dir, "out.log"), undefined, { idleMs: 1_000 });
    expect(result.status).toBe("completed");
    expect(result.code).toBe(0);
  }, 40_000);

  test("no deadline means no watchdog", async () => {
    const exe = await script("quick", 'printf "done\\n"\nexit 0');
    const result = await runSpawn([exe], dir, join(dir, "out.log"));
    expect(result.status).toBe("completed");
  }, 20_000);

  test("activity on a watched file counts as life, even with a silent out-log", async () => {
    // The shape of every healthy `claude -p` turn: stdout is buffered until
    // the turn ends, so the out-log sits at zero bytes through minutes of
    // real work - while the session transcript grows on every step. The
    // watchdog must read that transcript as life, or it kills the turn
    // mid-work (it did: exit 143, seconds after the turn had already
    // replied through a side channel).
    const transcript = join(dir, "transcript.jsonl");
    await writeFile(transcript, "");
    const exe = await script(
      "buffered",
      `i=0\nwhile [ $i -lt 16 ]; do echo tick >> ${transcript}; sleep 0.15; i=$((i+1)); done\nexit 0`,
    );
    const result = await runSpawn([exe], dir, join(dir, "out.log"), undefined, {
      idleMs: 600,
      activityPaths: [transcript],
    });
    expect(result.status).toBe("completed");
    expect(result.code).toBe(0);
  }, 40_000);

  test("a stall is reported as stalled, distinct from a child that failed on its own", async () => {
    const exe = await script("wedged", "sleep 600");
    const result = await runSpawn(
      [exe],
      dir,
      join(dir, "out.log"),
      // A declared identity strategy, so the classifier runs and the stalled
      // flag has somewhere to live.
      {
        harness: "stub",
        sessionId: "s-1",
        strategy: { source: "caller-assigned", argument: "--sid" },
      },
      { idleMs: 800 },
    );
    expect(result.status).toBe("process-failed");
    expect(result.status === "process-failed" && result.stalled).toBe(true);
  }, 40_000);
});
