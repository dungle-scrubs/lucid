import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEAD_HUB_PORT, ENV_POLICY, harnessEnv, MUST_ISOLATE } from "./e2e/harness-env.ts";

const REPO = join(import.meta.dirname, "..");

/** Every `LUCID_*` the product reads from its environment. Reads only - a name
 *  the product WRITES for a child it spawns is not something the developer's
 *  shell can leak into. */
const lucidVarsReadUnderSrc = async (): Promise<string[]> => {
  const entries = (
    await readdir(join(REPO, "src"), { withFileTypes: true, recursive: true })
  ).filter((e) => e.isFile() && e.name.endsWith(".ts"));
  const found = new Set<string>();
  for (const entry of entries) {
    const text = await readFile(join(entry.parentPath, entry.name), "utf8");
    // `process.env.X`, `env.X`, and destructuring off an env-shaped object.
    for (const match of text.matchAll(/(?:process\.)?env(?:\??)\.(LUCID_[A-Z0-9_]+)/g)) {
      if (match[1]) found.add(match[1]);
    }
    // Declared as a field on an env interface, which is how ports.ts reads.
    for (const match of text.matchAll(/readonly\s+(LUCID_[A-Z0-9_]+)\??:/g)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
};

describe("harness environment isolation", () => {
  test("every LUCID_* the product reads has been classified", async () => {
    // The guard that outlives today's list. Isolating the current variables is
    // a one-off; the thing worth building is that adding a new one to src/ and
    // forgetting the harness becomes a red test rather than a slow leak back
    // onto whoever's home directory the suite happens to run in.
    const read = await lucidVarsReadUnderSrc();
    const unclassified = read.filter((name) => !(name in ENV_POLICY));
    expect(unclassified).toEqual([]);
    // And the reverse: a policy entry for something nothing reads is a stale
    // rule that will outlive its reason and mislead the next person.
    const stale = Object.keys(ENV_POLICY).filter((name) => !read.includes(name));
    expect(stale).toEqual([]);
  });

  test("the harness env sets every variable marked isolate", async () => {
    const env = harnessEnv("/tmp/example-test-dir");
    const missing = MUST_ISOLATE.filter((name) => env[name] === undefined);
    expect(missing).toEqual([]);
  });

  test("nothing isolated points outside the test's own directory", () => {
    // The failure this exists to prevent is a path that looks contained and is
    // not - an absolute default, a `~` that never expanded, a relative path
    // resolved against the wrong cwd.
    const dir = "/tmp/example-test-dir";
    const env = harnessEnv(dir);
    const escaping = Object.entries(env).filter(
      ([, value]) => value.includes("/") && !value.startsWith(`${dir}/`),
    );
    expect(escaping).toEqual([]);
  });

  test("the three that reached the developer's real home are contained", async () => {
    // Named individually rather than left to the loop above, because these are
    // the ones D-011 was written about: the settings the human edits, and the
    // two Claude directories holding their session history.
    const env = harnessEnv("/tmp/example-test-dir");
    for (const name of ["LUCID_SETTINGS", "LUCID_CLAUDE_SESSIONS", "LUCID_CLAUDE_PROJECTS"]) {
      expect(env[name]).toStartWith("/tmp/example-test-dir/");
    }
  });
});

describe("the unit suite's own containment", () => {
  test("hub discovery is pinned, so no test can find a real hub", () => {
    // Asserted rather than assumed: the preload is configured in bunfig.toml,
    // which is a file this test would otherwise never notice being deleted,
    // renamed, or shadowed by a bunfig in a parent directory.
    expect(process.env.LUCID_HUB_PORT).toBe(DEAD_HUB_PORT);
  });

  test("the preload is actually wired up in bunfig.toml", async () => {
    // The test above passes if someone exports LUCID_HUB_PORT in their shell,
    // which would hide a deleted preload until CI - or until a machine where
    // nobody had. This checks the wiring itself.
    const bunfig = await readFile(join(REPO, "bunfig.toml"), "utf8");
    expect(bunfig).toContain("./test/preload.ts");
  });

  test("the files that reach hub discovery are known", async () => {
    // Not a rule, a record. Three unit files reach discovery and only one ever
    // pinned a port; if that set grows, the preload is what is protecting the
    // newcomer, and whoever removes it should see what they are removing.
    const reaching: string[] = [];
    for (const name of (await readdir(join(REPO, "test"), { withFileTypes: true }))
      // This file names those symbols in the regex below, so it matches itself.
      .filter(
        (e) => e.isFile() && e.name.endsWith(".test.ts") && e.name !== "env-isolation.test.ts",
      )
      .map((e) => e.name)) {
      const text = await readFile(join(REPO, "test", name), "utf8");
      if (/runDaemon|hubInfo|hubAlive|discoverLiveServer/.test(text)) reaching.push(name);
    }
    expect(reaching.sort()).toEqual(["attend.test.ts", "daemon.test.ts", "launch.test.ts"]);
  });
});

describe("nothing in the suite copies a signed platform binary", () => {
  test("no test executes a copy of anything under /bin, /usr/bin or /sbin", async () => {
    // This is not a style rule. Two fixtures copied `/bin/sleep` to a temp path
    // and executed the copy, because macOS derives `comm` from the executed
    // file's name and that was the only way to make a real process answer to
    // "claude". A copied platform binary fails code signature validation: macOS
    // SIGKILLs it, and enough repetitions crash `syspolicyd` - which then
    // throttles for twenty minutes and stops NEW APPLICATIONS LAUNCHING
    // machine-wide. Running this suite in a loop cost two hard restarts before
    // anyone connected the two. Inject the dependency instead; see
    // `setProcessLister` in src/core/presence.ts.
    const offenders: string[] = [];
    const dirs = ["test", "scripts"];
    for (const dir of dirs) {
      const entries = (await readdir(join(REPO, dir), { withFileTypes: true, recursive: true }))
        .filter((e) => e.isFile() && /\.(ts|tsx|sh)$/.test(e.name))
        .filter((e) => e.name !== "env-isolation.test.ts");
      for (const entry of entries) {
        const path = join(entry.parentPath, entry.name);
        const text = await readFile(path, "utf8");
        // A copy whose SOURCE is a system binary path, in code rather than prose.
        for (const line of text.split("\n")) {
          if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
          if (/(copyFile|cp)\s*\(?\s*["'`]\/(bin|usr\/bin|sbin|usr\/sbin)\//.test(line)) {
            offenders.push(`${path.slice(REPO.length + 1)}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
