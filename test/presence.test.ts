import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  harnessSessionCwd,
  harnessSessionId,
  harnessSupportsPresence,
  interactiveResumeCommand,
  type HarnessPresence,
  livePresence,
  presenceFor,
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
  await rm(dir, { recursive: true, force: true });
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
  /** A real process whose command name matches the harness, so the `ps` guard
   *  sees what it sees in production. `sleep` copied under a claude-ish name
   *  is the cheapest honest way to get one. */
  const spawnHarnessLike = async (): Promise<{ pid: number; kill: () => Promise<void> }> => {
    const bin = join(dir, "claude-testproc");
    await copyFile("/bin/sleep", bin);
    await chmod(bin, 0o755);
    // Short, and AWAITED on teardown: an unawaited subprocess keeps a handle
    // on bun's loop and holds the whole file open for its lifetime.
    const proc = Bun.spawn([bin, "5"], { stdout: "ignore", stderr: "ignore" });
    return {
      pid: proc.pid,
      kill: async () => {
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
