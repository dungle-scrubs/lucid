import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cursorSidecarPath, sessionPaths } from "../src/core/paths.ts";

/**
 * Docs drift against the code the moment a path moves. Plan 02 relocated every
 * machine-local sidecar under `run/`; the human-facing contract has to say so,
 * or an agent reading CONTRACT.md addresses a file that is not there.
 *
 * This is not a spell-check: the expected shapes are DERIVED from
 * `src/core/paths.ts`, so the day someone moves a sidecar back out of `run/`
 * (or documents it at the old place) exactly one of these fails.
 */

const REPO = join(import.meta.dir, "..");
const contract = readFileSync(join(REPO, "docs/CONTRACT.md"), "utf8");

// A canonical record: artifact and record both under `<project>/.lucid/`.
const paths = sessionPaths("/proj/.lucid/demo.html");

/** The machine-local sidecars, as their path RELATIVE to the record dir. */
const machineLocalRel = [
  paths.currentHtml,
  paths.serverJson,
  paths.serverLog,
  paths.attendLog,
  paths.createLog,
  paths.contextSidecar,
  paths.selectionPath,
  cursorSidecarPath(paths, "claude-code"),
].map((f) => relative(paths.sessionDir, f));

/** The committed history, relative to the record dir - must NOT be under run/. */
const committedRel = [paths.logPath, paths.versionsDir, paths.pastedDir].map((f) =>
  relative(paths.sessionDir, f),
);

describe("paths.ts is the source of truth the docs must track", () => {
  test("every machine-local sidecar lives under run/", () => {
    for (const rel of machineLocalRel) expect(rel.startsWith("run/")).toBe(true);
  });

  test("committed history stays at the record root, never under run/", () => {
    for (const rel of committedRel) expect(rel.startsWith("run/")).toBe(false);
  });
});

describe("docs/CONTRACT.md tracks the run/ split (plan 02)", () => {
  // Each machine-local sidecar CONTRACT.md mentions must appear under
  // `.lucid/<name>/run/`, never directly under `.lucid/<name>/`.
  for (const base of ["server.json", "selection.json", "context.json"]) {
    test(`${base} is documented under run/, not at the record root`, () => {
      const stale = new RegExp(`\\.lucid/<name>/${base.replace(".", "\\.")}`);
      expect(contract).not.toMatch(stale);
    });
  }

  test("the per-harness cursor sidecar is documented under run/", () => {
    expect(contract).not.toMatch(/\.lucid\/<name>\/cursor\./);
  });

  test("the run/ record subdir is named in the contract", () => {
    expect(contract).toContain(".lucid/<name>/run/");
  });
});
