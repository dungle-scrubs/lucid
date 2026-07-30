import { hook, on } from "./locators.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  MAIN,
  PLAN_V1,
  openIntoHub,
  startHub,
  type Cli,
  type Hub,
  waitTimeoutSeconds,
} from "./helpers.ts";

/**
 * The human picks the harness's MODEL and EFFORT: in the create dialog for a
 * new artifact, and in the chat area for an artifact's later unattended turns.
 *
 * These run against a registry fixture of their own whose spawn recipe is a
 * script that records its argv - so "the pick reached the CLI" is asserted on
 * the actual command line, not on a mock.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;
let listener: ChildProcess | undefined;
/** Holds the fake harness, which must exist BEFORE the hub reads the registry
 *  naming it - so it cannot live in the hub's own dir. */
let fixtures: string | undefined;

/** The vocabulary shape the pickers must handle: a model with its OWN effort
 *  ladder (codex's per-generation subsets in miniature) beside one that falls
 *  back to the harness-wide ladder. */
const registry = (exe: string) => ({
  default: "claude-code",
  harnesses: {
    "claude-code": {
      spawn: [exe, "--print", "{prompt}"],
      models: [
        { id: "opus-4.8", label: "Opus 4.8", efforts: ["low", "medium", "high"] },
        { id: "sonnet-5", label: "Sonnet 5" },
      ],
      defaultModel: "opus-4.8",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    },
  },
});

/** A harness that only records how it was invoked, then exits: the create turn
 *  dies without authoring, which is fine - the argv is the assertion. */
const writeFakeHarness = async (): Promise<{ exe: string; argvFile: string }> => {
  fixtures = await mkdtemp(join(tmpdir(), "lucid-harness-e2e-"));
  const exe = join(fixtures, "fake-harness");
  const argvFile = join(fixtures, "argv.txt");
  await writeFile(exe, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\nexit 1\n`);
  await chmod(exe, 0o755);
  return { exe, argvFile };
};

const selectionFile = (c: Cli): string => join(c.dir, "plan", "run", "selection.json");

test.afterEach(async () => {
  listener?.kill("SIGKILL");
  listener = undefined;
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
  if (fixtures) await rm(fixtures, { recursive: true, force: true });
  fixtures = undefined;
});

test("the create dialog offers the registry's models and the pick reaches the argv", async ({
  page,
}) => {
  const { exe, argvFile } = await writeFakeHarness();
  hub = await startHub({ attend: true, harnesses: registry(exe) });
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  await expect(on(page).shellTab()).toHaveCount(1);
  // Two root candidates post-#88 (the session's project + the scan root), so
  // the dialog would ask; this test is about the pickers, so remember one.
  await page.evaluate((root) => localStorage.setItem("lucid.createRoot", root), cli.dir);
  await on(page).tabAdd().click();
  await on(page).newArtifact().click();

  // Both pickers exist because the registry declares both lists, and each
  // opens on "default" - the row that sends nothing and lets the CLI decide.
  await expect(on(page).createModel()).toContainText("default (opus-4.8)");
  await expect(on(page).createEffort()).toContainText("default (medium)");

  // The ladder follows the MODEL: with none picked, the default model's own
  // efforts apply, so the harness-wide extras are not on offer.
  await on(page).createEffort().click();
  await expect(page.getByRole("option", { name: "high", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "xhigh", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A model with no efforts of its own falls back to the harness ladder, and
  // the extra rungs appear.
  await on(page).createModel().click();
  await page.getByRole("option", { name: /Sonnet 5/ }).click();
  await on(page).createEffort().click();
  await page.getByRole("option", { name: "xhigh", exact: true }).click();

  await on(page).createName().fill("authored");
  await on(page).createPrompt().fill("a rollout plan for billing");
  await on(page).createSubmit().click();
  await expect(on(page).createAuthoring()).toBeVisible();

  // The harness's own flags, in the recipe's argv: the adapter put them right
  // after the executable, where a positional prompt cannot swallow them.
  await expect
    .poll(async () => await readFile(argvFile, "utf8").catch(() => ""), { timeout: 20_000 })
    .toContain("--model");
  const argv = (await readFile(argvFile, "utf8")).trim().split("\n");
  expect(argv.slice(0, 5)).toEqual(["--model", "sonnet-5", "--effort", "xhigh", "--print"]);

  // And it STICKS to the artifact: every later unattended turn reuses it. The
  // record sits beside the artifact, and create authors into the project's
  // `.lucid/` (plan 05, M3.2) - so the record is `.lucid/authored/`.
  const stuck = JSON.parse(
    await readFile(join(cli.dir, ".lucid", "authored", "run", "selection.json"), "utf8"),
  ) as Record<string, string>;
  expect(stuck).toMatchObject({ harness: "claude-code", model: "sonnet-5", effort: "xhigh" });
});

test("the chat pickers write the artifact's sticky selection", async ({ page }) => {
  hub = await startHub({ harnesses: registry("/bin/true") });
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  await page.goto(opened.shellUrl);
  const pickers = page.locator(`${hook("selection-pickers")}:visible`);
  await expect(pickers).toHaveAttribute("data-readonly", "false");
  await expect(on(pickers).selectionModel()).toContainText("default (opus-4.8)");

  await on(pickers).selectionModel().click();
  await page.getByRole("option", { name: /Opus 4\.8/ }).click();
  await expect(on(pickers).selectionModel()).toContainText("Opus 4.8");

  await on(pickers).selectionEffort().click();
  await page.getByRole("option", { name: "high", exact: true }).click();

  const file = selectionFile(cli);
  await expect.poll(async () => await readFile(file, "utf8").catch(() => "")).toContain("opus-4.8");
  const stuck = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  expect(stuck).toMatchObject({ harness: "claude-code", model: "opus-4.8", effort: "high" });
});

test("an attending session's own model is shown, not offered", async ({ page }) => {
  hub = await startHub({ harnesses: registry("/bin/true") });
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  const artifact = cli.artifact;
  const env = { ...hub.env, LUCID_HARNESS: "claude-code", LUCID_MODEL: "opus-4.8" };

  // A finished wait records WHO attended and what it runs (the sidecar is
  // written on exit); a second, still-blocked one is the live presence. Both
  // carry a cursor, which is what makes a wait BLOCK rather than read and
  // return.
  const waitArgs = [
    "run",
    MAIN,
    "wait",
    artifact,
    "--harness",
    "claude-code",
    "--since",
    "evt_00001",
  ];
  await new Promise<void>((resolve) => {
    const done = spawn("bun", [...waitArgs, "--timeout", waitTimeoutSeconds(1)], {
      env,
      stdio: "ignore",
    });
    done.once("exit", () => resolve());
  });
  listener = spawn("bun", [...waitArgs, "--timeout", waitTimeoutSeconds(30)], {
    env,
    stdio: "ignore",
  });

  await page.goto(opened.shellUrl);
  const pickers = page.locator(`${hook("selection-pickers")}:visible`);
  // Lucid cannot move a live conversation onto another model, so the pickers
  // report the attendant's own instead of offering a choice that would lie.
  await expect(pickers).toHaveAttribute("data-readonly", "true", { timeout: 20_000 });
  await expect(on(pickers).selectionModel()).toContainText("Opus 4.8");
  await expect(on(pickers).selectionEffort()).toContainText("inherited from claude-code");
  await on(pickers).selectionModel().hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    "an interactive session runs its own model",
  );
});

test("an attendant arriving mid-session is read afresh, not from the open tab's snapshot", async ({
  page,
}) => {
  hub = await startHub({ harnesses: registry("/bin/true") });
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;
  const artifact = cli.artifact;

  // The tab is open BEFORE anyone attends, so its folded snapshot names no
  // attendant at all. Presence frames carry only a count, so without a re-read
  // the row would flip to a readout of nothing the moment an agent arrived.
  await page.goto(opened.shellUrl);
  const pickers = page.locator(`${hook("selection-pickers")}:visible`);
  await expect(pickers).toHaveAttribute("data-readonly", "false", { timeout: 20_000 });

  const env = { ...hub.env, LUCID_HARNESS: "claude-code", LUCID_MODEL: "sonnet-5" };
  const waitArgs = [
    "run",
    MAIN,
    "wait",
    artifact,
    "--harness",
    "claude-code",
    "--since",
    "evt_00001",
  ];
  await new Promise<void>((resolve) => {
    const done = spawn("bun", [...waitArgs, "--timeout", waitTimeoutSeconds(1)], {
      env,
      stdio: "ignore",
    });
    done.once("exit", () => resolve());
  });
  listener = spawn("bun", [...waitArgs, "--timeout", waitTimeoutSeconds(30)], {
    env,
    stdio: "ignore",
  });

  await expect(pickers).toHaveAttribute("data-readonly", "true", { timeout: 20_000 });
  await expect(on(pickers).selectionModel()).toContainText("Sonnet 5");
});
