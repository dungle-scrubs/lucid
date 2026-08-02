import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpawn } from "../src/launch/launcher.ts";
import type {
  NativeSessionIdentity,
  StdoutJsonlSessionIdentity,
} from "../src/launch/session-identity.ts";

/**
 * A turn a hub spawns must call back to THAT hub (plan 08, finding #21).
 *
 * The create prompt's last instruction is `lucid open <artifact>`, and `open`
 * finds a hub through `LUCID_HUB_PORT`, falling back to the default 17428. The
 * hub never told its children which port it was on, so a hub started anywhere
 * else spawned turns that opened their artifact against whatever happened to be
 * listening on the default - another hub, or nothing.
 *
 * Found by measuring plan 07's 8-minute create: the spawned turn's `open`
 * returned a URL on 17428 while the test's own hub was on a different port, and
 * a real hub was in fact listening there.
 */

let dir: string;

/** A fake harness that records the environment it was handed. */
const writeEnvDumper = async (): Promise<{ exe: string; dump: string }> => {
  const exe = join(dir, "dump-env");
  const dump = join(dir, "env.txt");
  await writeFile(exe, `#!/bin/sh\nenv > ${dump}\nexit 0\n`);
  await chmod(exe, 0o755);
  return { exe, dump };
};

/** The value the child saw for `name`, or undefined when it saw none. */
const sawValue = (env: string, name: string): string | undefined => {
  const line = env.split("\n").find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1);
};

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-spawn-port-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a spawned turn is told which hub spawned it", () => {
  test("the hub's port reaches the child's environment", async () => {
    const { exe, dump } = await writeEnvDumper();

    await runSpawn([exe], dir, join(dir, "out.log"), {
      harness: "claude",
      sessionId: "child-1",
      hubPort: 23456,
    });

    const env = await readFile(dump, "utf8");
    expect(sawValue(env, "LUCID_HUB_PORT")).toBe("23456");
  });

  test("an inherited port is REPLACED, not kept", async () => {
    // The hazard this closes: a hub started from a shell that already exported
    // a different port would otherwise hand its children that stale value, and
    // the turn would open its artifact into somebody else's hub.
    const previous = process.env.LUCID_HUB_PORT;
    process.env.LUCID_HUB_PORT = "17428";
    try {
      const { exe, dump } = await writeEnvDumper();

      await runSpawn([exe], dir, join(dir, "out.log"), {
        harness: "claude",
        sessionId: "child-2",
        hubPort: 23456,
      });

      const env = await readFile(dump, "utf8");
      expect(sawValue(env, "LUCID_HUB_PORT")).toBe("23456");
    } finally {
      if (previous === undefined) delete process.env.LUCID_HUB_PORT;
      else process.env.LUCID_HUB_PORT = previous;
    }
  });

  test("a spawner that is not a hub leaves the variable alone", async () => {
    // Not every spawn comes from a hub, and inventing a port for one that has
    // none would be worse than saying nothing: `open` has a documented default
    // and a fabricated value would route a turn at a hub that does not exist.
    const previous = process.env.LUCID_HUB_PORT;
    delete process.env.LUCID_HUB_PORT;
    try {
      const { exe, dump } = await writeEnvDumper();

      await runSpawn([exe], dir, join(dir, "out.log"), {
        harness: "claude",
        sessionId: "child-3",
      });

      const env = await readFile(dump, "utf8");
      expect(sawValue(env, "LUCID_HUB_PORT")).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env.LUCID_HUB_PORT = previous;
    }
  });
});

describe("streaming identity discovery through runSpawn", () => {
  const codexStrategy: StdoutJsonlSessionIdentity = {
    allowRotation: false,
    event: "thread.started",
    field: "thread_id",
    requiredArgument: "--json",
    source: "stdout-jsonl",
  };
  const launchId = "abc123def4567890";

  test("split JSONL discovers identity while the child is live; output bytes are untouched", async () => {
    // The stub emits the thread id SPLIT across two writes (real pipes split
    // wherever they like), then narrates, then WAITS for the discovery
    // callback's handshake file before exiting - so a passing test PROVES the
    // callback ran while the child was still alive, with no timing luck.
    const exe = join(dir, "codex-stub");
    const handshake = join(dir, "seen-by-parent");
    await writeFile(
      exe,
      `#!/bin/sh
printf '{"type":"thread.started","thread_'
sleep 0.05
printf 'id":"019f-native"}\n'
echo "narration line the log must keep"
i=0
while [ ! -f ${handshake} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
echo '{"type":"turn.completed"}'
exit 0
`,
    );
    await chmod(exe, 0o755);

    const discovered: NativeSessionIdentity[] = [];
    const result = await runSpawn([exe, "--json"], dir, join(dir, "out.log"), {
      harness: "codex",
      launchId,
      strategy: codexStrategy,
      onIdentityDiscovered: async (identity) => {
        discovered.push(identity);
        await writeFile(handshake, "ack");
      },
    });

    expect(discovered).toEqual([
      { authority: "observed", harness: "codex", sessionId: "019f-native" },
    ]);
    expect(result).toEqual({
      code: 0,
      identity: { authority: "observed", harness: "codex", sessionId: "019f-native" },
      status: "completed",
    });
    // The log sink got EXACTLY the bytes the harness wrote - equality, not
    // containment, because a tee that duplicated or reordered chunks would
    // still "contain" every line.
    const log = await readFile(join(dir, "out.log"), "utf8");
    expect(log).toBe(
      '{"type":"thread.started","thread_id":"019f-native"}\n' +
        "narration line the log must keep\n" +
        '{"type":"turn.completed"}\n',
    );
  });

  test("a clean discovered exit without identity is HSI002; a nonzero exit stays a process failure", async () => {
    const silent = join(dir, "silent-stub");
    await writeFile(silent, "#!/bin/sh\necho no structured output here\nexit 0\n");
    await chmod(silent, 0o755);
    expect(
      await runSpawn([silent, "--json"], dir, join(dir, "s.log"), {
        harness: "codex",
        launchId,
        strategy: codexStrategy,
      }),
    ).toEqual({ code: 0, error: "HSI002", status: "identity-missing" });

    const failing = join(dir, "failing-stub");
    await writeFile(failing, "#!/bin/sh\nexit 9\n");
    await chmod(failing, 0o755);
    expect(
      await runSpawn([failing, "--json"], dir, join(dir, "f.log"), {
        harness: "codex",
        launchId,
        strategy: codexStrategy,
      }),
    ).toEqual({ code: 9, status: "process-failed" });
  });

  test("a spawn that cannot start is spawn-failed, typed", async () => {
    expect(
      await runSpawn([join(dir, "does-not-exist")], dir, join(dir, "x.log"), {
        harness: "codex",
        launchId,
        strategy: codexStrategy,
      }),
    ).toEqual({ code: 127, status: "spawn-failed" });
  });

  test("stderr is logged evidence, never identity", async () => {
    const exe = join(dir, "stderr-stub");
    await writeFile(
      exe,
      `#!/bin/sh\necho '{"type":"thread.started","thread_id":"via-stderr"}' >&2\nexit 0\n`,
    );
    await chmod(exe, 0o755);
    const discovered: NativeSessionIdentity[] = [];
    const result = await runSpawn([exe, "--json"], dir, join(dir, "err.log"), {
      harness: "codex",
      launchId,
      strategy: codexStrategy,
      onIdentityDiscovered: (identity) => {
        discovered.push(identity);
      },
    });
    // The line is in the log for a human to read - and established nothing.
    expect(await readFile(join(dir, "err.log"), "utf8")).toContain("via-stderr");
    expect(discovered).toEqual([]);
    expect(result).toEqual({ code: 0, error: "HSI002", status: "identity-missing" });
  });

  test("discovered recipes clear inherited identity; caller-assigned exports it with authority", async () => {
    const { exe, dump } = await writeEnvDumper();

    // Plant an inherited identity: the assertion below is that the child does
    // NOT see these, which asserts nothing unless they exist to leak.
    const previous = {
      authority: process.env.LUCID_SESSION_ID_AUTHORITY,
      sessionId: process.env.LUCID_SESSION_ID,
    };
    process.env.LUCID_SESSION_ID = "parent-session-must-not-leak";
    process.env.LUCID_SESSION_ID_AUTHORITY = "observed";
    try {
      await runSpawn([exe, "--json"], dir, join(dir, "e1.log"), {
        harness: "codex",
        launchId,
        strategy: codexStrategy,
      });
    } finally {
      if (previous.sessionId === undefined) delete process.env.LUCID_SESSION_ID;
      else process.env.LUCID_SESSION_ID = previous.sessionId;
      if (previous.authority === undefined) delete process.env.LUCID_SESSION_ID_AUTHORITY;
      else process.env.LUCID_SESSION_ID_AUTHORITY = previous.authority;
    }
    let env = await readFile(dump, "utf8");
    // A discovered harness mints its own id: the parent's must not leak in,
    // or the child stamps its events as a conversation that is not its own.
    expect(sawValue(env, "LUCID_SESSION_ID")).toBeUndefined();
    expect(sawValue(env, "LUCID_SESSION_ID_AUTHORITY")).toBeUndefined();
    expect(sawValue(env, "LUCID_LAUNCH_ID")).toBe(launchId);

    await runSpawn([exe], dir, join(dir, "e2.log"), {
      harness: "claude",
      sessionId: "assigned-1",
      launchId,
      strategy: { argument: "--session-id", source: "caller-assigned" },
    });
    env = await readFile(dump, "utf8");
    expect(sawValue(env, "LUCID_SESSION_ID")).toBe("assigned-1");
    expect(sawValue(env, "LUCID_SESSION_ID_AUTHORITY")).toBe("assigned");
    expect(sawValue(env, "LUCID_LAUNCH_ID")).toBe(launchId);
  });
});
