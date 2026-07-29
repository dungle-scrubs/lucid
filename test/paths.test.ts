import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { sessionPaths, cursorSidecarPath } from "../src/core/paths.ts";
import { ensureSessionDirs } from "../src/core/session.ts";

/**
 * The content / machine-local split (plan 02, MB.1).
 *
 * A record's committed history (`log.ndjson`, `versions/`, `pasted/`) stays
 * directly under the record dir; everything machine-local (the served copy, the
 * lock, the server descriptor, the out-logs, the sidecars) moves under `run/`,
 * so a single `run/` line in the record's `.gitignore` keeps the whole record
 * committable by default and no new sidecar can leak.
 */

describe("SessionPaths: content stays, runtime moves under run/", () => {
  const p = sessionPaths("/proj/.lucid/plan.html");
  const run = join(p.sessionDir, "run");

  test("runDir is <record>/run", () => {
    expect(p.runDir).toBe(run);
  });

  test("the committed history stays directly under the record", () => {
    expect(p.logPath).toBe(join(p.sessionDir, "log.ndjson"));
    expect(p.versionsDir).toBe(join(p.sessionDir, "versions"));
    expect(p.pastedDir).toBe(join(p.sessionDir, "pasted"));
  });

  test("every machine-local file resolves under run/", () => {
    for (const field of [
      p.currentHtml,
      p.serverJson,
      p.serverLog,
      p.attendLog,
      p.createLog,
      p.contextSidecar,
      p.selectionPath,
    ]) {
      expect(dirname(field)).toBe(run);
    }
    expect(basename(p.currentHtml)).toBe("current.html");
    expect(basename(p.serverJson)).toBe("server.json");
    expect(basename(p.selectionPath)).toBe("selection.json");
  });

  test("the per-harness cursor sidecar is under run/", () => {
    expect(dirname(cursorSidecarPath(p, "claude-code"))).toBe(run);
  });
});

describe("ensureSessionDirs: committable by default, never a bare *", () => {
  let dir: string;
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "lucid-paths-"));
    return sessionPaths(join(dir, ".lucid", "plan.html"));
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  test("the record's .gitignore is exactly run/, so history is committed by default", () => {
    const p = setup();
    try {
      ensureSessionDirs(p);
      expect(readFileSync(join(p.sessionDir, ".gitignore"), "utf8").trim()).toBe("run/");
      expect(existsSync(p.runDir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("no bare `*` is ever written at any level - the R1 untracking trap", () => {
    const p = setup();
    try {
      ensureSessionDirs(p);
      expect(readFileSync(join(p.sessionDir, ".gitignore"), "utf8").trim()).not.toBe("*");
    } finally {
      cleanup();
    }
  });
});

describe("the dual-layout machinery is gone (plan 02, MB.2)", () => {
  test("no SessionPaths field or migration for the old .lucid container", async () => {
    // The one-time move to canonical is the migration tool's job (MB.4/MB.5),
    // not an open-time rename. `migrateLegacySessionDir` and `legacySessionDir`
    // were deleted; a reference would fail to typecheck, and this pins their
    // absence in the source so a well-meaning re-introduction is loud.
    const p = sessionPaths("/proj/.lucid/plan.html") as unknown as Record<string, unknown>;
    expect("legacySessionDir" in p).toBe(false);
    for (const file of [
      "../src/core/session.ts",
      "../src/core/paths.ts",
      "../src/server/daemon.ts",
    ]) {
      const src = await Bun.file(new URL(file, import.meta.url)).text();
      expect(src.includes("migrateLegacySessionDir")).toBe(false);
      expect(src.includes("legacySessionDir")).toBe(false);
    }
  });
});
