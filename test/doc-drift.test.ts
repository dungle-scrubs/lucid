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

describe("the diagnosis surface CONTRACT.md documents is the one that exists (plan 07)", () => {
  const verboseSrc = readFileSync(join(REPO, "src/core/verbose.ts"), "utf8");
  const observeSrc = readFileSync(join(REPO, "src/server/observe.ts"), "utf8");

  test("every subsystem the doc names is one the code accepts, and vice versa", () => {
    // A doc naming a subsystem the parser drops sends the reader to set a
    // flag that silently does nothing - the exact failure LUCID_VIEW had.
    const declared = /VERBOSE_SUBSYSTEMS = \[([^\]]*)\]/.exec(verboseSrc)?.[1] ?? "";
    const names = [...declared.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(contract).toContain(`\`${name}\``);
    expect(contract).toContain("LUCID_VERBOSE");
  });

  test("the log path the doc tells you to grep is the one the code writes", () => {
    expect(contract).toContain("~/.lucid/hub.log");
    expect(observeSrc).toContain('resolve(homedir(), ".lucid", "hub.log")');
  });

  test("the doc states the rule that keeps the flag from cancelling the records", () => {
    // Read as a blanket silence rule, technique 4 cancels technique 2.
    expect(contract).toMatch(/never gated|not gated|always on/i);
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

  test("the drain flag is accepted BY WAIT, and the wait usage map says so", () => {
    expect(embedded).toContain("--timeout 0");
    // Wired into the WAIT command, not merely declared somewhere in the file.
    // Asserting `Options.integer("timeout")` existed was theatre: removing
    // `timeout: timeoutOpt` from wait's own record left every test green while
    // the literal command this doc instructs died with "Received unknown
    // argument: '--timeout'".
    const waitCmd = /Command\.make\(\s*"wait",\s*\{[^}]*\}/s.exec(mainSrc)?.[0] ?? "";
    expect(waitCmd, "could not find wait's Command.make record").not.toBe("");
    expect(waitCmd).toContain("timeout:");
    expect(waitCmd).toContain("since:");
    // ...and advertised in the usage map. A doc naming a flag the CLI's own
    // usage omits sends the reader to the source to check whether it is real.
    const usage = /wait: "lucid wait <file>[^"]*"/.exec(runSrc)?.[0] ?? "";
    expect(usage).toContain("--timeout");
    expect(usage).toContain("--since");
  });

  test("the view field the doc documents is the one open PRINTS", () => {
    expect(embedded).toContain('"view"');
    // In the print payload, not merely somewhere in the file. `view,` alone
    // was satisfied by the `selectOpenUrl({ view, ... })` call site, so
    // deleting the field from `print({...})` left this green while the doc's
    // "always present, in both views" became false.
    // Anchored on the payload region rather than matched with a brace regex,
    // which the nested `...(warnings.length > 0 ? {...} : {})` spread defeats.
    const start = runSrc.indexOf("nextCursor: renderCursor(result.cursor),");
    expect(start, "could not find open's print payload").toBeGreaterThan(-1);
    const printed = runSrc.slice(start, runSrc.indexOf("});", start));
    expect(printed).toContain("view,");
    expect(printed).toContain("url,");
  });

  test("the doc warns that `warnings` is optional, because open really emits it", () => {
    // Found by running the doc's own instructions: the example payload showed
    // six keys, and a harness author parsing that shape strictly breaks the
    // first time an artifact earns an advisory.
    expect(embedded).toContain("warnings");
    expect(runSrc).toContain("warnings.length > 0");
  });

  test("the skill points at the doc rather than restating it", () => {
    expect(skill).toContain("docs/EMBEDDED.md");
    expect(skill).toContain("LUCID_VIEW=solo");
  });

  test("the skill INSTRUCTS the export, it does not merely mention it (plan 07, M3.3)", () => {
    // The capability shipped in plan 06 and was never once exercised, because
    // the skill described the export as something an integration already does
    // ("Your integration exports ...") rather than telling the reader to do
    // it. A mention is not an instruction, and the token alone was satisfied
    // by prose - so this asserts the shell line an integrator can copy.
    // The fence is built rather than written literally - a backtick fence
    // inside a regex literal ends the enclosing expression.
    const fenced = /`{3}sh\n[^`]*export LUCID_VIEW=solo/;
    expect(skill).toMatch(fenced);
    // And the same shape in the doc it defers to, so the two cannot drift
    // into instructing differently.
    expect(embedded).toMatch(fenced);
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

describe("the turn's declared intent is instructed, not assumed (finding #18)", () => {
  const skill = readFileSync(join(REPO, "skills/lucid/SKILL.md"), "utf8");
  const attendSrc = readFileSync(join(REPO, "src/server/attend.ts"), "utf8");
  const launcherSrc = readFileSync(join(REPO, "src/launch/launcher.ts"), "utf8");

  test("no spawner claims an intent before the turn has read anything", () => {
    // The hub and the launcher both write a delivery ack before the turn
    // starts. A delivery claim is not a promise about output: claiming
    // "revise" there made the viewer announce an artifact update for feedback
    // that changed nothing.
    expect(attendSrc).not.toContain('intent: "revise"');
    expect(launcherSrc).not.toContain('intent: "revise"');
  });

  test("the skill tells the agent to declare it, since nothing else can", () => {
    // Dropping the speculative claim without this would trade a lie for a
    // missing signal - `lucid intent` existed and no instruction used it.
    // The literal command, not the word "revise" - which appears in prose on
    // main and made this vacuous. And the prompt too, since that is the only
    // text a hub-driven turn ever reads.
    expect(skill).toContain("lucid intent <file> revise");
    const launcher = readFileSync(join(REPO, "src/launch/launcher.ts"), "utf8");
    // A regex, not a string: `${artifact}` inside a plain string reads as a
    // botched template literal and the linter says so, correctly.
    expect(launcher).toMatch(/lucid intent \$\{artifact\} revise/);
  });
});
