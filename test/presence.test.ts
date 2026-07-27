import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  harnessPidsIn,
  harnessSessionCwd,
  harnessSessionId,
  harnessSupportsPresence,
  interactiveResumeCommand,
  type HarnessPresence,
  livePresence,
  presenceFor,
  realPs,
  resetProcessLister,
  setProcessLister,
  resetPresenceCache,
} from "../src/core/presence.ts";

/** Was this session found, and is it interactive? */
const live_interactive = (map: Map<string, HarnessPresence>, id: string): boolean =>
  map.get(id)?.interactive === true;

/**
 * Detecting whether the conversation behind an artifact is open in a terminal
 * right now. The fixtures write session files exactly as Claude Code does -
 * one per pid - and use THIS process's pid for "alive" (it is a bun process,
 * not a claude one, so the command-name guard is exercised too).
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lucid-presence-"));
});

afterEach(async () => {
  // Unconditional, and not only in the fixture's own teardown: a test that
  // installs a stub lister and then throws never reaches its undo, and one
  // leaked stub disables presence detection for every file that runs after it.
  resetProcessLister();
  await rm(dir, { recursive: true, force: true });
});

/**
 * The real `ps` call, against processes this test spawns itself.
 *
 * Everything that can be wrong here is invisible to a stubbed lister, because
 * every failure mode - wrong flags, a mis-joined pid list, a missing binary -
 * collapses to empty output, which `harnessPidsIn` reads as "nothing is live"
 * and every caller reads as "no conversation is open". That is the exact
 * production defect this module exists to prevent, so it cannot be the thing
 * the suite stops looking at.
 *
 * Two processes, deliberately: with one pid, `pids.join(",")` and
 * `pids.join(" ")` produce the same string and a broken join goes unnoticed.
 */
describe("realPs asks the OS and gets an answer back", () => {
  test("reports a line per live pid, with the command name the OS has for it", async () => {
    const a = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    const b = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const out = await realPs([a.pid, b.pid]);
      const lines = out.split("\n").filter((l) => l.trim() !== "");
      expect(lines).toHaveLength(2);
      // Both pids present, each followed by a command name - the shape
      // `harnessPidsIn` parses. `comm` is the executed file's name: `sleep`.
      expect(lines.map((l) => Number.parseInt(l.trim(), 10)).sort()).toEqual([a.pid, b.pid].sort());
      for (const line of lines) expect(line).toMatch(/^\s*\d+\s+\S*sleep\s*$/);
    } finally {
      a.kill();
      b.kill();
      await Promise.all([a.exited, b.exited]);
    }
  });

  test("a pid nothing owns produces no line, rather than an error", async () => {
    // `ps -p` exits non-zero when it matches nothing. The caller must read that
    // as "not running", which is only true if the output is empty and the
    // non-zero exit is not thrown at anyone.
    expect((await realPs([DEAD_PID])).trim()).toBe("");
  });

  test("a plain `sleep` is not mistaken for a conversation", async () => {
    // The whole point of reading `comm`: a live pid is not enough.
    const proc = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      expect(harnessPidsIn(await realPs([proc.pid])).size).toBe(0);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

/** The pure half, tested directly - the docstring in presence.ts claims it is,
 *  and until now nothing imported it. */
describe("harnessPidsIn", () => {
  test("keeps the pids whose command name names the harness, in any case", () => {
    const out = ["  501 claude", " 502 sleep", "503 Claude Code Helper", "504 bun"].join("\n");
    expect([...harnessPidsIn(out)].sort()).toEqual([501, 503]);
  });

  test("a command name with spaces survives whole", () => {
    expect([...harnessPidsIn("777 not-claude at all")]).toEqual([777]);
  });

  test("empty output, blank lines and headers yield nothing", () => {
    expect(harnessPidsIn("").size).toBe(0);
    expect(harnessPidsIn("\n\n   \n").size).toBe(0);
    expect(harnessPidsIn("  PID COMM\n").size).toBe(0);
  });

  test("a pid that is a prefix of another is not confused with it", () => {
    // 50 and 501 both appear; only the one whose own line names claude counts.
    expect([...harnessPidsIn("50 sleep\n501 claude")]).toEqual([501]);
  });
});

const writeSession = async (pid: number, body: Record<string, unknown>): Promise<void> => {
  await writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, ...body }));
};

/** A pid that cannot be running: max_pid on macOS is 99999. */
const DEAD_PID = 999_999;

describe("livePresence", () => {
  test("a missing sessions directory is not an error - the harness is just absent", async () => {
    expect((await livePresence(join(dir, "nope"))).size).toBe(0);
  });

  test("a session whose process is gone is dropped", async () => {
    await writeSession(DEAD_PID, {
      sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
      kind: "interactive",
    });
    expect((await livePresence(dir)).size).toBe(0);
  });

  test("a live pid that is NOT the harness is dropped - stale file, reused pid", async () => {
    // This test process is alive and is `bun`, not `claude`: exactly the shape
    // of a hard-killed session whose file survived and whose pid came back as
    // something else. Without the command check this would read as live.
    await writeSession(process.pid, {
      sessionId: "aaaaaaaa-0000-4000-8000-000000000002",
      kind: "interactive",
    });
    expect((await livePresence(dir)).size).toBe(0);
  });

  test("unreadable and half-written files are skipped, not fatal", async () => {
    await writeFile(join(dir, "bad.json"), "{ not json");
    await writeFile(join(dir, "empty.json"), "");
    await writeSession(DEAD_PID, { sessionId: "aaaaaaaa-0000-4000-8000-000000000003" });
    expect((await livePresence(dir)).size).toBe(0);
  });

  test("a file with no session id is ignored", async () => {
    await writeSession(DEAD_PID, { kind: "interactive" });
    expect((await livePresence(dir)).size).toBe(0);
  });
});

describe("livePresence finds a running conversation", () => {
  /**
   * A real running process, reported to the liveness check under a
   * harness-like name.
   *
   * The pid is genuine - a plain `sleep`, actually running, actually reaped -
   * so "this pid is alive" stays a real observation. Only the NAME `ps` would
   * report is substituted.
   *
   * This used to copy `/bin/sleep` to `claude-testproc` and execute the copy,
   * because `comm` comes from the executed file's name and that is the only way
   * to make a real process answer to "claude". A copied platform binary fails
   * macOS code signature validation: the process is SIGKILLed, and enough
   * repetitions crash `syspolicyd`, which then throttles and stops NEW
   * APPLICATIONS LAUNCHING machine-wide. That cost this project two hard
   * restarts before the suite was identified as the cause. Nothing in `test/`
   * may copy a signed platform binary.
   */
  const spawnHarnessLike = async (): Promise<{ pid: number; kill: () => Promise<void> }> => {
    // Short, and AWAITED on teardown: an unawaited subprocess keeps a handle
    // on bun's loop and holds the whole file open for its lifetime.
    const proc = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    const restore = setProcessLister(async (pids) =>
      pids.map((pid) => `${pid} ${pid === proc.pid ? "claude-testproc" : "other"}`).join("\n"),
    );
    return {
      pid: proc.pid,
      kill: async () => {
        restore();
        proc.kill();
        await proc.exited;
      },
    };
  };

  test("an interactive session is reported with its status and cwd", async () => {
    const proc = await spawnHarnessLike();
    try {
      await writeSession(proc.pid, {
        sessionId: "bbbbbbbb-0000-4000-8000-000000000001",
        cwd: "/Users/k/dev/sdlc",
        kind: "interactive",
        status: "idle",
      });
      const live = await livePresence(dir);
      expect(live.get("bbbbbbbb-0000-4000-8000-000000000001")).toEqual({
        sessionId: "bbbbbbbb-0000-4000-8000-000000000001",
        pid: proc.pid,
        interactive: true,
        cwd: "/Users/k/dev/sdlc",
        status: "idle",
      });
    } finally {
      await proc.kill();
    }
  });

  test("a headless run is live but NOT interactive - nobody is at that keyboard", async () => {
    const proc = await spawnHarnessLike();
    try {
      await writeSession(proc.pid, {
        sessionId: "bbbbbbbb-0000-4000-8000-000000000002",
        kind: "print",
      });
      expect(
        live_interactive(await livePresence(dir), "bbbbbbbb-0000-4000-8000-000000000002"),
      ).toBe(false);
    } finally {
      await proc.kill();
    }
  });

  test("presenceFor joins an attendant record to its running conversation", async () => {
    const id = "bbbbbbbb-0000-4000-8000-000000000003";
    const proc = await spawnHarnessLike();
    try {
      await writeSession(proc.pid, { sessionId: id, kind: "interactive" });
      resetPresenceCache();
      // The sdlc shape: no declared session id, only the recorded resume.
      const found = await presenceFor(
        { harness: "claude-code", resume: `claude --resume ${id}` },
        undefined,
        dir,
      );
      expect(found?.interactive).toBe(true);

      // An unsupported harness never consults the sweep, whatever is running.
      expect(
        await presenceFor({ harness: "codex", resume: `codex resume ${id}` }, undefined, dir),
      ).toBeUndefined();
    } finally {
      await proc.kill();
      resetPresenceCache();
    }
  });
});

describe("harnessSupportsPresence", () => {
  test("claude-code in its spellings, and nothing else", () => {
    expect(harnessSupportsPresence("claude-code")).toBe(true);
    expect(harnessSupportsPresence("claude_code")).toBe(true);
    expect(harnessSupportsPresence("Claude")).toBe(true);
    expect(harnessSupportsPresence("codex")).toBe(false);
    expect(harnessSupportsPresence("")).toBe(false);
  });
});

describe("harnessSessionId", () => {
  const id = "40c9c345-b638-4286-bfce-796d9e6fad98";

  test("prefers what the agent declared", () => {
    expect(harnessSessionId({ sessionId: id, resume: "claude --resume other" })).toBe(id);
  });

  test("falls back to the id embedded in the recorded resume command", () => {
    // How a session opened before Lucid asked for the stamp is still joinable.
    expect(
      harnessSessionId({ resume: `claude --resume ${id} --dangerously-skip-permissions` }),
    ).toBe(id);
  });

  test("falls back to the scratchpad path, which is named by the session", () => {
    expect(
      harnessSessionId({
        artifactDir: `/private/tmp/claude-501/-Users-k-dev-sdlc/${id}/scratchpad`,
      }),
    ).toBe(id);
  });

  test("reads the id through a nested scratchpad folder", () => {
    expect(
      harnessSessionId({
        artifactDir: `/private/tmp/claude-501/-Users-k-dev-sdlc/${id}/scratchpad/repro`,
      }),
    ).toBe(id);
  });

  test("no id anywhere is undefined, never a guess", () => {
    expect(harnessSessionId({})).toBeUndefined();
    expect(harnessSessionId({ resume: "claude --continue" })).toBeUndefined();
    expect(harnessSessionId({ artifactDir: "/Users/k/dev/lucid/docs" })).toBeUndefined();
  });
});

describe("harnessSessionCwd", () => {
  test("answers the cwd the harness FILED that conversation under", async () => {
    // The only source that cannot be wrong: `claude --resume <id>` finds a
    // session only from the cwd it is filed under, and the transcript's own
    // directory names that cwd. Guessing from the artifact's folder (or the
    // hub's own cwd) resolved to a real directory and failed every turn with
    // "No conversation found with session ID".
    const root = await mkdtemp(join(tmpdir(), "lucid-projects-"));
    const home = await mkdtemp(join(tmpdir(), "lucid-real-"));
    const project = join(home, "dev", "sdlc");
    await mkdir(project, { recursive: true });
    const encoded = project.replaceAll("/", "-").replaceAll(".", "-");
    await mkdir(join(root, encoded), { recursive: true });
    await writeFile(join(root, encoded, "sess-abc.jsonl"), "{}\n", "utf8");

    expect(await harnessSessionCwd("sess-abc", root)).toBe(project);
    // An id filed nowhere is undefined, not a guess.
    expect(await harnessSessionCwd("sess-missing", root)).toBeUndefined();
  });

  test("a missing projects directory is not an error", async () => {
    expect(await harnessSessionCwd("sess-abc", join(tmpdir(), "lucid-absent-projects"))).toBe(
      undefined,
    );
  });
});

describe("interactiveResumeCommand yolo flag", () => {
  test("adds each harness's own skip-permissions flag when asked", () => {
    expect(interactiveResumeCommand("claude-code", "s1", { yolo: true })).toBe(
      "claude --resume s1 --dangerously-skip-permissions",
    );
    expect(interactiveResumeCommand("codex", "s1", { yolo: true })).toBe(
      "codex resume s1 --dangerously-bypass-approvals-and-sandbox",
    );
  });

  test("omits it when the setting is off", () => {
    expect(interactiveResumeCommand("claude-code", "s1", { yolo: false })).toBe(
      "claude --resume s1",
    );
    expect(interactiveResumeCommand("claude-code", "s1")).toBe("claude --resume s1");
  });
});
