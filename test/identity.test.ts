import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactPath, sessionPaths } from "../src/core/paths.ts";

/**
 * A session's identity is the artifact's REAL path (plan 05, M1.1, #41).
 *
 * `resolve` normalizes `..` and relative segments but not symlinks, so
 * `lucid open plan.html` and `lucid open link-to-plan.html` minted two
 * identities for one file: two records, two logs, one artifact - and
 * annotations landing in whichever log the last invocation happened to pick.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A real temp dir. `realpath`, because macOS resolves /tmp -> /private/tmp and
 *  the product canonicalizes: a test comparing paths against the un-resolved
 *  spelling fails on the symlink it is not testing. */
const tmp = async (): Promise<string> => {
  const d = await realpath(await mkdtemp(join(tmpdir(), "lucid-identity-")));
  dirs.push(d);
  return d;
};

describe("canonicalArtifactPath resolves symlinks", () => {
  test("a symlink and its target are ONE identity", async () => {
    const dir = await tmp();
    const real = join(dir, "plan.html");
    await writeFile(real, "<h1>plan</h1>");
    const link = join(dir, "link.html");
    await symlink(real, link);

    // The identity, and everything derived from it, must agree.
    expect(canonicalArtifactPath(link)).toBe(canonicalArtifactPath(real));
    expect(sessionPaths(link).logPath).toBe(sessionPaths(real).logPath);
  });

  test("a symlinked DIRECTORY resolves too - the record lives beside the real file", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "real"), { recursive: true });
    const real = join(dir, "real", "plan.html");
    await writeFile(real, "<h1>plan</h1>");
    await symlink(join(dir, "real"), join(dir, "alias"));

    expect(canonicalArtifactPath(join(dir, "alias", "plan.html"))).toBe(
      canonicalArtifactPath(real),
    );
  });

  test("a BROKEN symlink resolves its directory, never invents a target", async () => {
    const dir = await tmp();
    const link = join(dir, "dangling.html");
    await symlink(join(dir, "gone.html"), link);
    // realpath cannot resolve the dangling FILE, so the resolved directory
    // plus the caller's own name is what surfaces - the not-found refusal
    // names what the human typed rather than inventing a target.
    expect(existsSync(link)).toBe(false); // the LINK exists, the target does not
    const { realpath } = await import("node:fs/promises");
    expect(canonicalArtifactPath(link)).toBe(join(await realpath(dir), "dangling.html"));
  });

  test("an ordinary path is unchanged", async () => {
    const dir = await tmp();
    const real = join(dir, "plan.html");
    await writeFile(real, "<h1>plan</h1>");
    expect(canonicalArtifactPath(real)).toBe(
      await import("node:fs/promises")
        .then((fs) => fs.realpath(dir))
        .then((d) => join(d, "plan.html")),
    );
  });

  test("a path that does not exist yet still normalizes (open creates it later)", async () => {
    const dir = await tmp();
    const notYet = join(dir, "sub", "..", "new.html");
    expect(canonicalArtifactPath(notYet)).toBe(
      join(await import("node:fs/promises").then((fs) => fs.realpath(dir)), "new.html"),
    );
  });
});

describe("assertNoStrandedRecord: the R3 migration guard", () => {
  const seedLog = async (artifact: string): Promise<void> => {
    const { sessionPaths } = await import("../src/core/paths.ts");
    const p = sessionPaths(artifact);
    await mkdir(p.sessionDir, { recursive: true });
    await writeFile(p.logPath, '{"seq":1,"t":"session_opened","at":"2026-01-01T00:00:00Z"}\n');
  };

  test("two records that BOTH hold history refuse to unify silently", async () => {
    const { assertNoStrandedRecord } = await import("../src/core/session.ts");
    const dir = await tmp();
    const real = join(dir, "plan.html");
    await writeFile(real, "<h1>plan</h1>");
    const link = join(dir, "link.html");
    await symlink(real, link);
    // History on BOTH sides - the pre-realpath world's two identities.
    await seedLog(real);
    const { sessionPaths: sp } = await import("../src/core/paths.ts");
    const literalRecord = join(dir, "link");
    await mkdir(literalRecord, { recursive: true });
    await writeFile(join(literalRecord, "log.ndjson"), '{"seq":1,"t":"session_opened"}\n');
    void sp;

    expect(() => assertNoStrandedRecord(link)).toThrow(/BOTH paths already hold a review record/);
  });

  test("only ONE side with history unifies silently - that is the fix", async () => {
    const { assertNoStrandedRecord } = await import("../src/core/session.ts");
    const dir = await tmp();
    const real = join(dir, "plan.html");
    await writeFile(real, "<h1>plan</h1>");
    const link = join(dir, "link.html");
    await symlink(real, link);
    await seedLog(real); // the target has history; the link never did
    expect(() => assertNoStrandedRecord(link)).not.toThrow();
  });

  test("an ordinary path with no link in play is never refused", async () => {
    const { assertNoStrandedRecord } = await import("../src/core/session.ts");
    const dir = await tmp();
    const real = join(dir, "plan.html");
    await writeFile(real, "<h1>plan</h1>");
    await seedLog(real);
    expect(() => assertNoStrandedRecord(real)).not.toThrow();
  });
});

describe("stem collision: two artifacts, one record name (plan 05, M1.2, D-006)", () => {
  const openInto = async (artifact: string, recordedName: string): Promise<void> => {
    const { sessionPaths } = await import("../src/core/paths.ts");
    const p = sessionPaths(artifact);
    await mkdir(p.sessionDir, { recursive: true });
    await writeFile(
      p.logPath,
      `${JSON.stringify({ seq: 1, at: "2026-01-01T00:00:00Z", t: "session_opened", segment: 1, version: 1, artifact: recordedName, hash: "h", path: "versions/s1/v1.html" })}\n`,
    );
  };

  test("a second stem is REFUSED, naming the record and the artifact that owns it", async () => {
    const { ensureSessionDirs } = await import("../src/core/session.ts");
    const { sessionPaths } = await import("../src/core/paths.ts");
    const dir = await tmp();
    // plan.html owns <dir>/plan/ ...
    await writeFile(join(dir, "plan.html"), "<h1>a</h1>");
    await openInto(join(dir, "plan.html"), "plan.html");
    // ...and plan.md derives the SAME record name.
    await writeFile(join(dir, "plan.md"), "# a");

    expect(() => ensureSessionDirs(sessionPaths(join(dir, "plan.md")))).toThrow(
      /already the review record for/,
    );
  });

  test("the refusal never appends to the first artifact's log", async () => {
    const { ensureSessionDirs } = await import("../src/core/session.ts");
    const { sessionPaths } = await import("../src/core/paths.ts");
    const { readFile } = await import("node:fs/promises");
    const dir = await tmp();
    await writeFile(join(dir, "plan.html"), "<h1>a</h1>");
    await openInto(join(dir, "plan.html"), "plan.html");
    const before = await readFile(sessionPaths(join(dir, "plan.html")).logPath, "utf8");

    await writeFile(join(dir, "plan.md"), "# a");
    try {
      ensureSessionDirs(sessionPaths(join(dir, "plan.md")));
    } catch {
      /* expected */
    }
    expect(await readFile(sessionPaths(join(dir, "plan.html")).logPath, "utf8")).toBe(before);
  });

  test("re-opening the SAME artifact is not a collision", async () => {
    const { ensureSessionDirs } = await import("../src/core/session.ts");
    const { sessionPaths } = await import("../src/core/paths.ts");
    const dir = await tmp();
    await writeFile(join(dir, "plan.html"), "<h1>a</h1>");
    await openInto(join(dir, "plan.html"), "plan.html");
    expect(() => ensureSessionDirs(sessionPaths(join(dir, "plan.html")))).not.toThrow();
  });

  test("a log that never recorded an artifact is left alone, not refused", async () => {
    const { ensureSessionDirs } = await import("../src/core/session.ts");
    const { sessionPaths } = await import("../src/core/paths.ts");
    const dir = await tmp();
    await writeFile(join(dir, "plan.md"), "# a");
    const p = sessionPaths(join(dir, "plan.md"));
    await mkdir(p.sessionDir, { recursive: true });
    await writeFile(p.logPath, '{"seq":1,"t":"annotation","at":"2026-01-01T00:00:00Z"}\n');
    expect(() => ensureSessionDirs(p)).not.toThrow();
  });
});

describe("a refusal leaves no phantom record (plan 05, M1.1)", () => {
  /**
   * `open` created the record directory before it ever read the artifact, so a
   * dangling symlink - or any unreadable file - exited 1 with a typed error AND
   * left a `<stem>/` folder holding a lone `.gitignore` beside the artifact.
   * The refusal is supposed to leave the directory exactly as it found it.
   */
  test("a dangling symlink refuses without creating the record directory", async () => {
    const { openSession } = await import("../src/core/session.ts");
    const dir = await tmp();
    await symlink(join(dir, "gone.html"), join(dir, "dangling.html"));
    const paths = sessionPaths(join(dir, "dangling.html"));

    await expect(openSession(paths)).rejects.toThrow(/cannot read artifact/);
    expect(existsSync(paths.sessionDir)).toBe(false);
  });

  test("an artifact that fails structural validation leaves nothing behind either", async () => {
    const { openSession } = await import("../src/core/session.ts");
    const dir = await tmp();
    const bad = join(dir, "bad.html");
    await writeFile(bad, "not html at all");
    const paths = sessionPaths(bad);

    await expect(openSession(paths)).rejects.toThrow(/structural validation/);
    expect(existsSync(paths.sessionDir)).toBe(false);
  });

  test("a readable artifact still opens - the guard costs nothing on the happy path", async () => {
    const { openSession } = await import("../src/core/session.ts");
    const dir = await tmp();
    const good = join(dir, "good.html");
    await writeFile(good, "<!doctype html><html><body><h1>good</h1></body></html>");
    const paths = sessionPaths(good);

    await openSession(paths);
    expect(existsSync(paths.logPath)).toBe(true);
  });
});

describe("both layouts present: the canonical wins, the legacy is untouched (plan 05, M3.1)", () => {
  /**
   * Records used to live at `<dir>/.lucid/<stem>/`; they live at
   * `<dir>/<stem>/` now (plan 02). A machine that pulled a repo migrated
   * elsewhere can hold BOTH. The listing still reads a legacy folder so the
   * history stays visible, but `open` must write only the canonical one and
   * must never merge, choose by scan order, or overwrite the legacy bytes.
   */
  const legacyLogOf = (dir: string, stem: string): string =>
    join(dir, ".lucid", stem, "log.ndjson");

  test("open writes the canonical record and leaves the legacy log byte-for-byte", async () => {
    const { openSession } = await import("../src/core/session.ts");
    const dir = await tmp();
    const artifact = join(dir, "plan.html");
    await writeFile(artifact, "<!doctype html><html><body><h1>plan</h1></body></html>");

    const legacy = legacyLogOf(dir, "plan");
    await mkdir(join(dir, ".lucid", "plan"), { recursive: true });
    const legacyBytes = `${JSON.stringify({ seq: 1, at: "2026-01-01T00:00:00Z", t: "session_opened", segment: 1, version: 1, artifact: "plan.html", hash: "legacy", path: "versions/s1/v1.html" })}\n`;
    await writeFile(legacy, legacyBytes);

    const paths = sessionPaths(artifact);
    await openSession(paths);

    // The canonical record is where the write landed...
    expect(paths.logPath).toBe(join(dir, "plan", "log.ndjson"));
    expect(existsSync(paths.logPath)).toBe(true);
    // ...and the legacy log is exactly as it was. Not merged, not appended to.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(legacy, "utf8")).toBe(legacyBytes);
  });

  test("the canonical log is chosen even though the legacy one is older and alphabetically first", async () => {
    const { openSession } = await import("../src/core/session.ts");
    const { foldLog } = await import("../src/core/fold.ts");
    const { readEvents } = await import("../src/core/log.ts");
    const dir = await tmp();
    const artifact = join(dir, "plan.html");
    await writeFile(artifact, "<!doctype html><html><body><h1>plan</h1></body></html>");
    await mkdir(join(dir, ".lucid", "plan"), { recursive: true });
    await writeFile(
      legacyLogOf(dir, "plan"),
      `${JSON.stringify({ seq: 1, at: "2020-01-01T00:00:00Z", t: "session_opened", segment: 1, version: 1, artifact: "plan.html", hash: "legacy", path: "versions/s1/v1.html" })}\n`,
    );

    const paths = sessionPaths(artifact);
    await openSession(paths);
    const state = foldLog((await readEvents(paths.logPath)).events);
    // v1 of a fresh record - never the legacy hash carried forward.
    expect(state.version).toBe(1);
    expect(paths.logPath.includes(".lucid")).toBe(false);
  });
});
