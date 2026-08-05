import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { viewerState, type ViewerStateHost } from "../src/core/viewer-state.ts";

/**
 * viewerState (plan 05, M3.1 / DF-1): the /__lucid/state assembly extracted
 * behind one core seam. The assembly is behavior-preserving against the old
 * inline route (covered by the session/server suites); these tests pin the
 * properties the extraction exists to make explicit:
 *
 * - agentsListening is a THUNK read at response-build time (D-006), never a
 *   pre-evaluated number an early-evaluating caller could freeze.
 * - a fresh artifact with no attendant sidecar and no stamped harness carries
 *   no lastAttendant and is not resumable.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A record whose log holds exactly `content` (empty = a fresh artifact). */
const withLog = async (content: string) => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-viewer-state-"));
  dirs.push(dir);
  const paths = sessionPaths(join(dir, "plan.html"));
  await mkdir(paths.runDir, { recursive: true });
  await writeFile(paths.logPath, content);
  return paths;
};

/** Write a `cursor.<harness>.json` attendant sidecar (D-051). */
const withAttendantSidecar = async (
  paths: SessionPaths,
  record: Record<string, unknown>,
  harness = "claude-code",
): Promise<void> => {
  await writeFile(join(paths.runDir, `cursor.${harness}.json`), JSON.stringify(record));
};

const host = (agentsListening: () => number): ViewerStateHost => ({ agentsListening });

describe("viewerState: agentsListening thunk (D-006)", () => {
  test("agentsListening is read from the thunk during assembly, not pre-evaluated", async () => {
    const paths = await withLog("");
    let calls = 0;
    let value = 0;
    const response = await viewerState(
      paths,
      host(() => {
        calls += 1;
        value = 42;
        return value;
      }),
    );
    // The thunk was called exactly once, and the response carries what it
    // returned at that call - proving the count is read during assembly, not
    // frozen by the caller before it.
    expect(calls).toBe(1);
    expect(response.agentsListening).toBe(42);
  });

  test("two reads of a changing thunk observe the later value", async () => {
    // The structural contract: the API takes () => number, so the host cannot
    // pre-evaluate. A thunk whose value moves between reads is observed at its
    // current value each time.
    const paths = await withLog("");
    let current = 1;
    const thunk = (): number => current;
    expect((await viewerState(paths, host(thunk))).agentsListening).toBe(1);
    current = 5;
    expect((await viewerState(paths, host(thunk))).agentsListening).toBe(5);
  });
});

describe("viewerState: a fresh artifact", () => {
  test("carries no lastAttendant and is not resumable", async () => {
    const paths = await withLog("");
    const response = await viewerState(
      paths,
      host(() => 0),
    );
    expect(response.resumable).toBe(false);
    expect(response.lastAttendant).toBeUndefined();
    // The lifecycle reports an unopened session (no log = no status derived).
    expect(response.lifecycle).toBe("none");
    expect(response.agentsListening).toBe(0);
  });
});

describe("viewerState: the attendant sidecar (D-051)", () => {
  test("a sidecar carries harness, at, resume, model, effort into lastAttendant", async () => {
    const paths = await withLog("");
    await withAttendantSidecar(paths, {
      harness: "claude-code",
      at: "2026-08-05T10:00:00Z",
      resume: "claude --resume abc-123",
      model: "opus",
      effort: "high",
    });
    const response = await viewerState(
      paths,
      host(() => 2),
    );
    expect(response.lastAttendant).toEqual({
      harness: "claude-code",
      at: "2026-08-05T10:00:00Z",
      resume: "claude --resume abc-123",
      model: "opus",
      effort: "high",
    });
    // The thunk is still read (D-006 holds alongside the sidecar).
    expect(response.agentsListening).toBe(2);
  });

  test("the sidecar's own resume command is kept as-is", async () => {
    // The sidecar records the agent's own flags; the constructed fallback is
    // only used when there is no recorded command. A sidecar resume wins.
    const paths = await withLog("");
    await withAttendantSidecar(paths, {
      harness: "claude-code",
      at: "2026-08-05T10:00:00Z",
      resume: "claude --resume sidecar-wins --dangerously-skip-permissions",
    });
    const response = await viewerState(
      paths,
      host(() => 0),
    );
    expect(response.lastAttendant?.resume).toBe(
      "claude --resume sidecar-wins --dangerously-skip-permissions",
    );
  });
});
