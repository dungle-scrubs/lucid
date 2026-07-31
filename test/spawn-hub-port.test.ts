import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpawn } from "../src/launch/launcher.ts";

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
