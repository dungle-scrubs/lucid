// Many artifacts, many sessions, one project - built once per test that needs
// them, never per scenario.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones add tests, never harness: an agent that needs to change something
// here has been scoped wrong, and the split is what makes that visible rather
// than a merge conflict nobody reads.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cli } from "./cli.ts";

/**
 * The artifact a scale fixture writes N of.
 *
 * Deliberately small and structurally valid: these scenarios are about the
 * COUNT of sessions, not the size of any one document (that is suite Q's
 * hostile corpus, and its huge-DOM fixture is a recorded product defect).
 * A fixture that was both large and numerous would measure two things at once
 * and blame the wrong one.
 */
const scaleArtifact = (title: string, n: number): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>${title}</title></head>
<body>
  <article>
    <h1>${title}</h1>
    <p id="claim" data-lucid-id="claim-${n}">Artifact ${n} of the scale fixture.</p>
    <ol id="steps">
      <li data-lucid-id="step-${n}">Step one of artifact ${n}</li>
      <li>Step two</li>
    </ol>
  </article>
</body>
</html>`;

export interface ScaleFixture {
  /** Absolute paths, in creation order. */
  readonly artifacts: readonly string[];
  /** The document titles, in the same order - what a tab or picker row shows. */
  readonly titles: readonly string[];
}

/**
 * Write `count` artifacts into the CLI's directory (one project).
 *
 * Writing only - opening is the caller's business, because the scenarios
 * differ in HOW they open (a hub, a drawer, one at a time) and that difference
 * is usually the thing under test. Titles are zero-padded so no title is a
 * prefix of another: `Scale 1` would substring-match `Scale 10`, and a test
 * asserting "this tab" would silently be asserting "any of three tabs".
 */
export const writeScaleArtifacts = async (cli: Cli, count: number): Promise<ScaleFixture> => {
  const width = String(count).length;
  const artifacts: string[] = [];
  const titles: string[] = [];
  for (let i = 1; i <= count; i++) {
    const label = String(i).padStart(width, "0");
    const title = `Scale ${label}`;
    const path = join(cli.dir, `scale-${label}.html`);
    await writeFile(path, scaleArtifact(title, i), "utf8");
    artifacts.push(path);
    titles.push(title);
  }
  return { artifacts, titles };
};

/**
 * Open every artifact in the fixture, sequentially.
 *
 * Sequential on purpose: `open` binds a port and writes a descriptor, and the
 * scenarios that care about concurrency belong to `concurrent-cli`. Doing it
 * in parallel here would make a port-pool test measure a race instead of a
 * pool.
 */
export const openAll = async (cli: Cli, artifacts: readonly string[]): Promise<void> => {
  for (const artifact of artifacts) await cli.run(["open", artifact]);
};
