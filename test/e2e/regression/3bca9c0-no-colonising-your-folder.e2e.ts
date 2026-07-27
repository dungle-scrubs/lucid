import { expect, test } from "@playwright/test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { makeCli, type Cli } from "../helpers.ts";

/**
 * Regression: `3bca9c0` - a session never colonises a folder that is yours.
 *
 * The record is named after its artifact, so `plan.html` claims `plan/`. A
 * human may already keep a `plan/` folder right there, and Lucid wrote its log,
 * its versions tree and a `*` .gitignore straight into it - burying their files
 * and taking them out of git without a word.
 *
 * The assertion is what the user would notice: their file is still there, git
 * still sees the folder, and the CLI said no instead of proceeding quietly.
 */

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

test("open refuses a record folder that already holds someone else's work", async () => {
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");

  // The collision: a folder of their own, named the way the record would be.
  const theirs = join(cli.dir, basename(cli.artifact).replace(/\.html$/, ""));
  await mkdir(theirs, { recursive: true });
  await writeFile(join(theirs, "notes.md"), "# my own notes, not Lucid's\n");

  const refused = await cli.run(["open", cli.artifact]).then(
    () => undefined,
    (error: unknown) => error as Error,
  );

  expect(refused, "open should have refused, and did not").toBeDefined();
  // It names the directory, because "something went wrong" is not actionable
  // when the fix is to rename a folder.
  expect(refused?.message).toContain(theirs);

  // Nothing of Lucid's was written into it, and nothing of theirs was lost.
  const after = (await readdir(theirs)).sort();
  expect(after, `Lucid wrote into a folder it does not own: ${after.join(", ")}`).toEqual([
    "notes.md",
  ]);
});
