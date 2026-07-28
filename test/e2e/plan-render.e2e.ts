import { expect, test } from "@playwright/test";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PLAN_V1, makeCli, type Cli } from "./helpers.ts";

/**
 * `lucid plan render <doc.md>` - the WRITE half.
 *
 * Where the artifact path comes from is unit-covered (test/plan-bridge.test.ts,
 * `planArtifactPath`), and deliberately not re-litigated here. What no unit can
 * answer is whether the command actually PUTS a file there: `planArtifactPath`
 * returning the right string and `runPlanRender` writing to it are two
 * different claims, and the second one is the whole command. The printed
 * `{artifact, next}` is the other half - an agent renders a doc and then runs
 * the `next` line, so a path that is right on disk and wrong on stdout strands
 * it just as completely.
 *
 * The `--out` half uses its own doc, so "landed at the --out path" and "landed
 * nowhere else" are both measurable: a render that ignored `--out` and wrote
 * beside the doc would satisfy the first on a shared fixture, because the
 * derived file would already be there from the default case.
 */

let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
});

const DOC = [
  "# Cutover plan",
  "",
  "<!-- D-042 -->",
  "",
  "The backfill runs in one batch, not nightly.",
  "",
  "## Open Questions",
  "",
  "1. Which store takes the cutover?",
  "",
].join("\n");

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

test("plan render writes the derived artifact, and --out lands exactly there", async () => {
  cli = await makeCli(PLAN_V1);

  // Default: beside the doc, named after it.
  const doc = join(cli.dir, "notes.md");
  await writeFile(doc, DOC);
  const rendered = (await cli.run(["plan", "render", doc])) as {
    artifact: string;
    next: string;
  };

  const derived = join(cli.dir, "notes.lucid.html");
  expect(rendered.artifact).toBe(derived);
  expect(isAbsolute(rendered.artifact)).toBe(true);
  // The `next` line is the thing an agent runs. An absolute path there is what
  // makes it runnable from a shell that started somewhere else.
  expect(rendered.next).toBe(`lucid open ${derived}`);

  // The file is on disk, and it is the RENDERED document - a path printed for a
  // file that was never written is the failure this test exists for.
  expect(await exists(derived), `plan render printed ${derived} but wrote nothing there`).toBe(
    true,
  );
  const html = await readFile(derived, "utf8");
  expect(html).toContain('data-lucid-id="D-042"');
  expect(html).toContain('data-lucid-id="Q-1"');

  // --out: a SECOND doc, so the derived path is still unwritten and can be
  // asserted absent.
  const other = join(cli.dir, "other.md");
  await writeFile(other, DOC);
  const out = join(cli.dir, "custom.html");
  const explicit = (await cli.run(["plan", "render", other, "--out", out])) as {
    artifact: string;
    next: string;
  };

  expect(explicit.artifact).toBe(out);
  expect(explicit.next).toBe(`lucid open ${out}`);
  expect(await exists(out), `--out ${out} was accepted but nothing was written there`).toBe(true);
  expect(await readFile(out, "utf8")).toContain('data-lucid-id="D-042"');
  expect(
    await exists(join(cli.dir, "other.lucid.html")),
    "--out was given, but the artifact also landed at the derived path",
  ).toBe(false);
});
