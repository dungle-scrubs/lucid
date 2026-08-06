import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEAD_HUB_PORT,
  ENV_POLICY,
  HARNESS_ENV_NAMES,
  harnessEnv,
  MUST_CLEAR,
  MUST_ISOLATE,
} from "./e2e/harness-env.ts";
import { UNIT_ENV } from "./unit-env.ts";

const REPO = join(import.meta.dirname, "..");

/** Line and block comments removed, so a name that only appears in prose is
 *  neither classified as a read nor counted as making a policy entry live. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Every `LUCID_*` the product reads from its environment. Reads only - a name
 *  the product WRITES for a child it spawns is not something the developer's
 *  shell can leak into. */
const lucidVarsReadUnderSrc = async (): Promise<string[]> => {
  const entries = (
    await readdir(join(REPO, "src"), { withFileTypes: true, recursive: true })
  ).filter((e) => e.isFile() && e.name.endsWith(".ts"));
  const found = new Set<string>();
  for (const entry of entries) {
    const text = withoutComments(await readFile(join(entry.parentPath, entry.name), "utf8"));
    // `process.env.X`, `env.X`, and the optional-chained forms.
    for (const match of text.matchAll(/(?:process\.)?env(?:\??)\.(LUCID_[A-Z0-9_]+)/g)) {
      if (match[1]) found.add(match[1]);
    }
    // Indexed: `process.env["LUCID_X"]`. A computed `process.env[name]` cannot
    // be resolved by reading and is the one form this scan cannot see.
    for (const match of text.matchAll(/env(?:\??)\[\s*["'`](LUCID_[A-Z0-9_]+)["'`]\s*\]/g)) {
      if (match[1]) found.add(match[1]);
    }
    // Destructured off an env-shaped object: `const { LUCID_X } = process.env`.
    for (const match of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:[A-Za-z_$][\w$]*\.)?env\b/g)) {
      for (const name of match[1]?.matchAll(/\bLUCID_[A-Z0-9_]+/g) ?? []) found.add(name[0]);
    }
    // Declared as a field on an env interface, which is how ports.ts reads.
    for (const match of text.matchAll(/readonly\s+(LUCID_[A-Z0-9_]+)\??:/g)) {
      if (match[1]) found.add(match[1]);
    }
    // A name table read back through computed `process.env[name]` access this
    // scan cannot follow (M5.5's env-stamp table in src/launch/env-stamp.ts,
    // read by src/cli/ack.ts): a quoted LUCID_* as an object-literal VALUE or
    // a const assignment is the env-var NAME, not a value the product ships.
    // Excludes union members (`| "..."`) and prose, which have no leading
    // `:` or `=`.
    for (const match of text.matchAll(/[:=]\s*["'`](LUCID_[A-Z0-9_]+)["'`]/g)) {
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

  test("the harness env sets every variable it is responsible for", async () => {
    const env = harnessEnv("/tmp/example-test-dir");
    const missing = HARNESS_ENV_NAMES.filter((name) => env[name] === undefined);
    expect(missing).toEqual([]);
  });

  test("nothing isolated points outside the test's own directory", () => {
    // The failure this exists to prevent is a path that looks contained and is
    // not - an absolute default, a `~` that never expanded, a relative path
    // resolved against the wrong cwd.
    const dir = "/tmp/example-test-dir";
    const env = harnessEnv(dir);
    const escaping = MUST_ISOLATE.filter((name) => !env[name]?.startsWith(`${dir}/`));
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

  test("a leaked harness identity does not survive into a spawned process", () => {
    // The failure: the Lucid skill exports LUCID_HARNESS and LUCID_SESSION_ID
    // into the agent's shell, so a suite run from an agent session that has
    // used Lucid stamps every artifact it opens with the DEVELOPER's harness
    // and their real session UUID - which then feeds presenceFor, the
    // "conversation is open" panel and the resume command. Modelled the way
    // helpers.ts composes it: the parent environment, then harnessEnv.
    const leaked = {
      PATH: "/usr/bin",
      LUCID_HARNESS: "claude",
      LUCID_SESSION_ID: "5389a5a6-d23a-4263-9163-aba1953fdfb0",
      LUCID_MODEL: "opus",
      LUCID_EFFORT: "high",
      LUCID_DEV_ASSETS: "/Users/someone/dev/lucid/dist",
    };
    const child = harnessEnv("/tmp/example-test-dir", leaked);
    for (const name of MUST_CLEAR) expect(child).not.toHaveProperty(name);
    // Not by wiping the environment: the child still needs to be able to run.
    expect(child.PATH).toBe("/usr/bin");
  });

  test("every cleared name is one the product really does read back", async () => {
    // `clear` is the strong claim in the policy: it says an inherited value
    // becomes somebody else's identity INSIDE the product, not merely that the
    // name is unset. The previous classification said the opposite of the truth
    // about these five - "nothing reads these from the developer's environment"
    // while src/cli/run.ts read four of them and src/server/dev-assets.ts the
    // fifth - and no test could tell, because membership was all that was
    // checked. This checks the reason, against src/.
    const read = await lucidVarsReadUnderSrc();
    const notActuallyRead = MUST_CLEAR.filter((name) => !read.includes(name));
    expect(notActuallyRead).toEqual([]);
  });
});

describe("the unit suite's own containment", () => {
  test("hub discovery is pinned, so no test can find a real hub", () => {
    // Asserted rather than assumed: the preload is configured in bunfig.toml,
    // which is a file this test would otherwise never notice being deleted,
    // renamed, or shadowed by a bunfig in a parent directory.
    expect(process.env.LUCID_HUB_PORT).toBe(DEAD_HUB_PORT);
  });

  test("every path the product would resolve into a real home is pinned", () => {
    // The hub port was one of nine, and the other eight were left to whichever
    // file remembered them. `LUCID_SETTINGS` was remembered by none: the
    // session host `attend.test.ts` drives calls `readSettingsCached()`, which
    // with nothing set reads the developer's own `~/.lucid/settings.json`.
    const unpinned = MUST_ISOLATE.filter((name) => process.env[name] !== UNIT_ENV[name]);
    expect(unpinned).toEqual([]);
  });

  test("no inherited harness identity survives into the unit suite either", () => {
    const present = MUST_CLEAR.filter((name) => process.env[name] !== undefined);
    expect(present).toEqual([]);
  });

  test("the preload is actually wired up in bunfig.toml", async () => {
    // The test above passes if someone exports LUCID_HUB_PORT in their shell,
    // which would hide a deleted preload until CI - or until a machine where
    // nobody had. This checks the wiring itself.
    const bunfig = await readFile(join(REPO, "bunfig.toml"), "utf8");
    expect(bunfig).toContain("./test/preload.ts");
  });

  test("the files that reach hub discovery are known", async () => {
    // Not a rule, a record. Four unit files reach discovery and only one ever
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
    expect(reaching.sort()).toEqual([
      "attend.test.ts",
      "cli-trace.test.ts",
      "daemon.test.ts",
      "deliver.test.ts",
      "launch.test.ts",
    ]);
  });
});

/**
 * The names of the system binary directories, assembled rather than written, so
 * this file's own rule does not read as a violation of it and the scan below
 * does not have to exempt itself by filename.
 */
const SYSTEM_BIN = ["bin", "usr/bin", "sbin", "usr/sbin"].join("|");

/** Any mention of a path under a system binary directory, in code rather than
 *  prose - whatever is done with it. Deliberately not a list of copy functions:
 *  `copyFile` was one word away from `copyFileSync`, and `cp`, `cpSync`,
 *  `Bun.file`, `readFile`, `link`, `install(1)` and a shelled-out `cp` all
 *  reintroduce the crash with a different verb. The source path is the one
 *  thing every version of the mistake has in common. */
const systemBinaryReference = new RegExp(String.raw`["'\`\s](/(${SYSTEM_BIN})/)`);

/** A shebang is a reference to an interpreter, not a copy of one, and
 *  `test/launch-stub.ts` legitimately writes `#!/usr/bin/env bun`. */
const isShebang = (line: string): boolean => /#!\s*\//.test(line);

/**
 * Lines that name a system binary and are allowed to.
 *
 * Naming one is safe; COPYING one is what crashes `syspolicyd`, and the rule
 * above is deliberately blunter than the hazard because a rule shaped exactly
 * like the hazard is evaded by the next spelling of it. The cost of that bluntness
 * is paid here, once, in the open - each entry names the line and why it is not
 * the mistake. An entry that stops matching anything fails as a stale rule, the
 * same way an unused ENV_POLICY entry does.
 */
const NAMED_BUT_NOT_COPIED: ReadonlyArray<{ readonly line: string; readonly why: string }> = [
  {
    // Assembled, not written out, for the same reason SYSTEM_BIN is: this file
    // is scanned by its own rule, and exempting it by filename would be a hole
    // in exactly the place the rule is defined.
    line: `hub = await startHub({ harnesses: registry("${["", "bin", "true"].join("/")}") });`,
    why: "Registers it AS a harness command. The product spawns it from its own signed location; nothing copies it, and a harness that exits 0 immediately is the point.",
  },
];

describe("nothing in the suite copies a signed platform binary", () => {
  test("no file under test/ or scripts/ so much as names a system binary path", async () => {
    // This is not a style rule. Two fixtures copied `/bin/sleep` to a temp path
    // and executed the copy, because macOS derives `comm` from the executed
    // file's name and that was the only way to make a real process answer to
    // "claude". A copied platform binary fails code signature validation: macOS
    // SIGKILLs it, and enough repetitions crash `syspolicyd` - which then
    // throttles for twenty minutes and stops NEW APPLICATIONS LAUNCHING
    // machine-wide. Running this suite in a loop cost two hard restarts before
    // anyone connected the two. Inject the dependency instead; see
    // `setProcessLister` in src/core/presence.ts.
    //
    // The bar is "names the path", not "copies it": a guard that enumerates
    // copy verbs is evaded by the next verb, and nothing in this suite has a
    // reason to name a system binary at all. `sleep` and `ps` are found on PATH.
    const allowed = new Set(NAMED_BUT_NOT_COPIED.map((entry) => entry.line));
    const matchedAllowance = new Set<string>();
    const offenders: string[] = [];
    for (const dir of ["test", "scripts"]) {
      const entries = (
        await readdir(join(REPO, dir), { withFileTypes: true, recursive: true })
      ).filter((e) => e.isFile() && /\.(ts|tsx|js|mjs|cjs|sh)$/.test(e.name));
      for (const entry of entries) {
        const path = join(entry.parentPath, entry.name);
        // Comments stripped rather than skipped line-by-line: a block comment
        // opening with `/*` was flagged, and a call split across two lines was
        // not seen at all.
        const text = withoutComments(await readFile(path, "utf8"));
        for (const line of text.split("\n")) {
          if (isShebang(line)) continue;
          if (!systemBinaryReference.test(line)) continue;
          const trimmed = line.trim();
          if (allowed.has(trimmed)) {
            matchedAllowance.add(trimmed);
            continue;
          }
          offenders.push(`${path.slice(REPO.length + 1)}: ${trimmed}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // A permission nothing uses any more is a rule that outlives its reason.
    expect([...allowed].filter((line) => !matchedAllowance.has(line))).toEqual([]);
  });

  test("the guard catches every shape the mistake has been written in", () => {
    // The guard is only worth what its regex catches, and the previous one
    // caught exactly one spelling. Each of these is a real way to put a signed
    // binary somewhere it will be executed from.
    const evasions = [
      `await copyFile("/bin/sleep", bin)`,
      `copyFileSync("/bin/sleep", bin)`,
      `fs.cpSync("/bin/sleep", bin)`,
      `await Bun.write(bin, Bun.file("/bin/sleep"))`,
      "await Bun.$`cp /bin/sleep /tmp/claude-testproc`",
      `execFileAsync("cp", ["/usr/bin/true", bin])`,
      `await writeFile(bin, await readFile("/bin/sleep"))`,
      `await symlink("/bin/sleep", bin)`,
      `cp /sbin/ping /tmp/claude-testproc`,
      `install -m 755 /usr/sbin/lsof /tmp/x`,
      `const SRC = "/bin/sleep";`,
    ];
    for (const line of evasions) expect(systemBinaryReference.test(line)).toBe(true);
  });

  test("the guard does not flag prose, or a shebang the suite legitimately writes", () => {
    expect(isShebang("#!/usr/bin/env bun")).toBe(true);
    expect(systemBinaryReference.test(withoutComments(`// copied /bin/sleep once`))).toBe(false);
    expect(systemBinaryReference.test(withoutComments(`/* copyFile("/bin/sleep") */`))).toBe(false);
    // Spawning by NAME is how the fixtures do it now, and must stay allowed.
    expect(systemBinaryReference.test(`Bun.spawn(["sleep", "5"])`)).toBe(false);
  });
});
