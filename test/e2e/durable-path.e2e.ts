import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliFailure } from "./cli-result.ts";
import { invoke } from "./cli.ts";
import { DEAD_HUB_PORT, harnessEnv } from "./harness-env.ts";
import { makeDurableArtifact, PLAN_V1, type DurableFixture } from "./helpers.ts";

/**
 * The refusal that keeps a review off a disk the OS wipes (M5.5).
 *
 * Days of review work have been lost to exactly this, which is why `open`
 * REFUSES rather than warns: a warning in an agent's output is read by nobody,
 * and the loss surfaces weeks later when the machine reboots with nothing to
 * recover from. A session's whole history lives beside its artifact, so a
 * volatile artifact takes the annotations, the versions and the replies with
 * it.
 *
 * Every test here runs WITHOUT `LUCID_ALLOW_TEMP`, which the rest of the suite
 * sets: that flag exists to let the harness drive real flows against temp
 * fixtures, and leaving it on here would mask the exact behaviour being
 * measured. The durable fixture is what makes that possible - an artifact
 * under `~/.lucid-e2e/`, outside both the temp tree and `defaultRoots()`.
 */

let durable: DurableFixture | undefined;
let strays: string[] = [];

test.afterEach(async () => {
  await durable?.cleanup();
  durable = undefined;
  for (const p of strays) await rm(p, { recursive: true, force: true });
  strays = [];
});

/** The harness env MINUS the temp opt-out - the refusal is the subject.
 *
 * `LUCID_HUB_PORT` is pinned dead, exactly as `launcher.e2e.ts` does, and for
 * the same reason: `harnessEnv` does not set it, so without this the CLI's
 * `open` inherits the port from the process and finds whatever hub the
 * developer is running. That hub then HOSTS the session and answers with its
 * own url, and the standalone-server path - the one that calls `recordOpen`
 * and writes `LUCID_OPEN_LOG` - is never taken. The launch-recording test then
 * reads an open log that was never written. Port 1 is privileged and never
 * bound, so the dedicated-server path is deterministic whether or not a hub is
 * up. */
const strictEnv = (dir: string): Record<string, string> => {
  const env = { ...harnessEnv(dir), LUCID_HUB_PORT: DEAD_HUB_PORT };
  delete (env as Record<string, string | undefined>).LUCID_ALLOW_TEMP;
  return env as Record<string, string>;
};

test("open refuses an artifact under /tmp and names a durable path to use", async () => {
  const dir = join(tmpdir(), `lucid-volatile-${Date.now()}`);
  const artifact = join(dir, "plan.html");
  strays.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(artifact, PLAN_V1, "utf8");

  const refused = await invoke(["open", artifact], {
    cwd: dir,
    timeout: 30_000,
    env: strictEnv(dir),
  }).then(
    () => undefined,
    (error: unknown) => error as CliFailure,
  );

  expect(refused, "open accepted an artifact the OS will delete").toBeInstanceOf(CliFailure);
  expect(refused?.code).toBe(1);
  const envelope = JSON.parse(refused?.stdout ?? "{}") as {
    error?: { code?: string; message?: string; detail?: { suggested?: string } };
  };
  expect(envelope.error?.code).toBe("VALIDATION_ERROR");

  // The refusal has to be ACTIONABLE: it says why (the OS clears it), what is
  // at stake (the history lives beside the artifact), and where to put it
  // instead. A bare "refused" would just get retried.
  expect(envelope.error?.message).toContain("temporary directory");
  expect(envelope.error?.message).toContain("annotations and versions");
  expect(envelope.error?.detail?.suggested, "the refusal named no alternative").toBeTruthy();
  expect(envelope.error?.detail?.suggested).toContain("plan.html");
});

test("$TMPDIR counts as volatile, not just the literal /tmp", async () => {
  // A machine whose TMPDIR points somewhere unusual is not less volatile for
  // it - and hardcoding /tmp would let exactly that machine lose work.
  //
  // The fixture lives OUTSIDE the hardcoded roots on purpose: under
  // `tmpdir()` this test passed with the TMPDIR arm deleted, because in a
  // Playwright worker `tmpdir()` resolves to /tmp and the hardcoded root was
  // doing the catching. Only a directory no hardcoded root covers can prove
  // the env is consulted at all.
  durable = await makeDurableArtifact(PLAN_V1);
  const dir = durable.dir;
  const artifact = durable.artifact;

  const refused = await invoke(["open", artifact], {
    cwd: dir,
    timeout: 30_000,
    // TMPDIR pointed AT this directory, so the guard must catch it through
    // the env rather than through the hardcoded roots.
    env: { ...strictEnv(dir), TMPDIR: dir },
  }).then(
    () => undefined,
    (error: unknown) => error as CliFailure,
  );

  expect(refused, "an artifact inside $TMPDIR was accepted").toBeInstanceOf(CliFailure);
  expect(JSON.parse(refused?.stdout ?? "{}").error?.code).toBe("VALIDATION_ERROR");
});

test("only the exact string LUCID_ALLOW_TEMP=1 opts out", async () => {
  const dir = join(tmpdir(), `lucid-optout-${Date.now()}`);
  strays.push(dir);
  await mkdir(dir, { recursive: true });
  const artifact = join(dir, "plan.html");
  await writeFile(artifact, PLAN_V1, "utf8");

  // "true" is what a person types when they mean yes, and it must NOT work:
  // a loose truthiness check would turn a guard against silent data loss into
  // a guard anyone disables by accident.
  for (const value of ["true", "yes", "0", ""]) {
    const refused = await invoke(["open", artifact], {
      cwd: dir,
      timeout: 30_000,
      env: { ...strictEnv(dir), LUCID_ALLOW_TEMP: value },
    }).then(
      () => undefined,
      (error: unknown) => error as CliFailure,
    );
    expect(
      refused,
      `LUCID_ALLOW_TEMP=${JSON.stringify(value)} opened a volatile artifact`,
    ).toBeInstanceOf(CliFailure);
  }

  // ...and the exact opt-out does work, or the escape hatch the whole suite
  // depends on would be broken and nothing here would notice.
  const opened = (await invoke(["open", artifact], {
    cwd: dir,
    timeout: 30_000,
    env: { ...strictEnv(dir), LUCID_ALLOW_TEMP: "1" },
  })) as { status: string };
  expect(opened.status).toBe("active");
  await invoke(["end", artifact], { cwd: dir, timeout: 30_000, env: strictEnv(dir) }).catch(
    () => undefined,
  );
});

test("a durable artifact opens, and the launch it would have made is recorded", async () => {
  durable = await makeDurableArtifact(PLAN_V1);
  const openLog = join(durable.dir, "open.ndjson");

  // The control that makes the refusal tests mean something: the SAME command
  // with the same strict env succeeds outside the temp tree. Without this, a
  // refusal that fired for any reason at all would look like the guard working.
  const opened = (await invoke(["open", durable.artifact], {
    cwd: durable.dir,
    timeout: 30_000,
    env: { ...strictEnv(durable.dir), LUCID_OPEN_LOG: openLog },
  })) as { status: string; session: string; url: string };

  expect(opened.status).toBe("active");
  expect(opened.url).toContain("127.0.0.1");

  // The D-015 observability seam: LUCID_NO_OPEN suppresses the window, which
  // is what the harness needs - and it also hides WHICH launch path would
  // have run, so "did it fall back to the default browser?" had no answer
  // short of watching a screen. Now it does.
  const recorded = (await readFile(openLog, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { how: string; url: string });
  expect(recorded.length, "no launch was recorded for an open that printed a url").toBeGreaterThan(
    0,
  );
  expect(recorded[0]?.url).toBe(opened.url);
  // Suppressed, not launched - the suite must never actually open a window.
  expect(recorded.every((r) => r.how === "skipped")).toBe(true);

  await invoke(["end", durable.artifact], {
    cwd: durable.dir,
    timeout: 30_000,
    env: strictEnv(durable.dir),
  }).catch(() => undefined);
});
