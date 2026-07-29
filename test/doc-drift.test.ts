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

/**
 * The embedded integration doc names an env var and a flag that the CODE has
 * to keep answering to (plan 06, M2.1). A doc that instructs a harness author
 * to export a variable nothing reads, or to pass a flag `lucid --help` does
 * not list, sends them to the source to find out which of the two is wrong.
 *
 * Both directions, and the HELP text as well as the parser: a check that only
 * looked at the parser would pass while the help stayed silent about the flag,
 * which is the state this milestone found the CLI in.
 */
describe("docs/EMBEDDED.md tracks the code it instructs against (plan 06)", () => {
  const embedded = readFileSync(join(REPO, "docs/EMBEDDED.md"), "utf8");
  const viewSrc = readFileSync(join(REPO, "src/server/view.ts"), "utf8");
  const runSrc = readFileSync(join(REPO, "src/cli/run.ts"), "utf8");
  const mainSrc = readFileSync(join(REPO, "src/cli/main.ts"), "utf8");
  const skill = readFileSync(join(REPO, "skills/lucid/SKILL.md"), "utf8");

  test("the env var the doc tells harnesses to export is the one the code reads", () => {
    expect(embedded).toContain("LUCID_VIEW=solo");
    // Read off the source, not restated: renaming the field reds this.
    expect(viewSrc).toContain("LUCID_VIEW");
    expect(viewSrc).toContain('=== "solo"');
  });

  test("the drain flag is PARSED, and the wait help says so", () => {
    expect(embedded).toContain("--timeout 0");
    // Parsed...
    expect(mainSrc).toContain('Options.integer("timeout")');
    // ...and advertised. A doc naming a flag the CLI's own usage omits sends
    // the reader to the source to check whether it is real.
    const usage = /wait: "lucid wait <file>[^"]*"/.exec(runSrc)?.[0] ?? "";
    expect(usage).toContain("--timeout");
    expect(usage).toContain("--since");
  });

  test("the view field the doc documents is the one open prints", () => {
    expect(embedded).toContain('"view"');
    expect(runSrc).toContain("view,");
  });

  test("the skill points at the doc rather than restating it", () => {
    expect(skill).toContain("docs/EMBEDDED.md");
    expect(skill).toContain("LUCID_VIEW=solo");
  });
});

/**
 * CONTEXT.md is normative vocabulary, so a word defined twice there is worse
 * than a word left undefined (plan 06, M2.2). This plan nearly gave **Surface**
 * a second meaning; the check is that it still has exactly one, and that the
 * concept it nearly collided with is present under its own name.
 */
describe("CONTEXT.md keeps one word to one meaning (plan 06)", () => {
  const context = readFileSync(join(REPO, "CONTEXT.md"), "utf8");
  const heading = (name: string): number =>
    context.split("\n").filter((line) => line.trim() === `### ${name}`).length;

  test("Surface and View are each defined exactly once", () => {
    expect(heading("Surface")).toBe(1);
    expect(heading("View")).toBe(1);
  });

  test("Surface still means the addressable rendering", () => {
    const body = context.slice(context.indexOf("### Surface"));
    expect(body.slice(0, 300)).toContain("addressable rendering");
  });

  test("View carries the invariant, and it is the one the code enforces", () => {
    const body = context.slice(context.indexOf("### View"), context.indexOf("### Viewer"));
    expect(body).toContain("presentation only");
    expect(body).toContain("never process topology");
    expect(body).toContain("LUCID_VIEW=solo");
    // Both values named, so a reader of `view: "shell"` can find it here.
    expect(body).toContain("**shell**");
    expect(body).toContain("**solo**");
  });
});
