import { expect, test } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

/** The folder a person keeps, named the way the record would be. */
const theirFolder = (dir: string, artifact: string): string =>
  join(dir, basename(artifact).replace(/\.html$/, ""));

test("open refuses a record folder that already holds someone else's work", async () => {
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");

  // The collision: a folder of their own, named the way the record would be.
  const theirs = theirFolder(cli.dir, cli.artifact);
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

test("a folder holding only a .gitignore is theirs too, not an empty one", async () => {
  // The hole the first version of this test walked past: ownership used to be
  // decided by "nothing here is unrecognised", and `.gitignore` was on the
  // recognised list - so a placeholder folder somebody keeps out of git read as
  // Lucid's own and was written over, `.gitignore` included. A file that both
  // parties write is not evidence of either.
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");
  const theirs = theirFolder(cli.dir, cli.artifact);
  await mkdir(theirs, { recursive: true });
  await writeFile(join(theirs, ".gitignore"), "build/\n");

  const refused = await cli.run(["open", cli.artifact]).then(
    () => undefined,
    (error: unknown) => error as Error,
  );

  expect(refused, "open colonised a folder that was not Lucid's").toBeDefined();
  const after = (await readdir(theirs)).sort();
  expect(after, `Lucid wrote into their folder: ${after.join(", ")}`).toEqual([".gitignore"]);
  expect(await readFile(join(theirs, ".gitignore"), "utf8")).toBe("build/\n");
});

test("a half-built record of Lucid's own is still Lucid's", async () => {
  // The other direction, and the reason ownership cannot simply be "is it
  // empty": an open interrupted before the log exists leaves a versions tree
  // and a descriptor behind. Refusing that would strand the session for good.
  cli = await makeCli("<!doctype html><html><body><h1>Plan</h1></body></html>");
  const ours = theirFolder(cli.dir, cli.artifact);
  await mkdir(join(ours, "versions"), { recursive: true });

  await cli.run(["open", cli.artifact]);
  expect((await readdir(ours)).sort()).toContain("log.ndjson");
});
