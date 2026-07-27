import { inArtifact, on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopbackFetch } from "../../src/server/discovery.ts";
import { CliFailure } from "./cli-result.ts";
// `invoke` is scoped off the barrel because it takes a raw env; this file is
// the case that scoping names (an env `makeCli` will not hand out), the same
// way hub.ts is.
import { invoke } from "./cli.ts";
import { harnessEnv } from "./harness-env.ts";
import {
  MAIN,
  PLAN_V1,
  makeCli,
  openIntoHub,
  startHub,
  surfaceOf,
  waitTimeoutSeconds,
  type Cli,
  type Hub,
} from "./helpers.ts";

/**
 * The surfaces around the shell: the hub as a process, and the CLI commands
 * that stand beside `open` (`launch`, `plan`, `app`).
 *
 * Two of these scenarios are about a catastrophe NOT happening - `open
 * --restart` must not take the hub down with it, and `LUCID_HUB_ATTEND` must
 * not silently turn a review-only install into one that spawns agents - so
 * each carries a positive effect of the same action alongside the absence,
 * and none of them asserts "nothing happened" against a value that was already
 * there.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;

/** A `lucid hub` this file spawned itself, because `startHub` takes no env and
 *  the whole point of `hub-attend-env-opt-in-is-strict` is the env. */
interface LocalHub {
  readonly port: number;
  readonly banner: string;
  readonly dir: string;
  stop(): Promise<void>;
}

const localHubs: LocalHub[] = [];

/** The detached hub `lucid app` spawned, and everything needed to reap it. */
let appHub: { readonly dir: string; readonly port: number; pid?: number } | undefined;

/** Ask the OS for a port, then give it straight back. `lucid app` must be told
 *  a port before it starts anything, so there is no "listening on" line to read
 *  one out of - this is the only way to know where to look for the hub it
 *  spawns, and it is the same trick `ports.ts` avoids needing by binding 0. */
const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no ephemeral port"))));
    });
  });

/** GET a hub route over the product's own loopback request shape, or
 *  `undefined` when nothing answers. */
const hubGet = async (port: number, path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const res = await loopbackFetch(port, path);
    if (!res.ok) return undefined;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/**
 * `lucid hub --port 0` with extra environment, stopped in `afterEach`.
 *
 * A copy of `startHub`'s shape rather than a change to it: `HubOptions` has no
 * `env`, harness signatures are frozen (D-014), and the env IS the subject
 * here - so the spawn lives with the test that needs it.
 */
const startHubWithEnv = async (extra: Record<string, string>): Promise<LocalHub> => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-envhub-e2e-"));
  const env = { ...harnessEnv(dir), LUCID_HUB_ROOTS: dir, ...extra };
  const child: ChildProcess = spawn("bun", ["run", MAIN, "hub", "--port", "0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async (): Promise<void> => {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
    });
    await rm(dir, { recursive: true, force: true });
  };
  const started = await new Promise<{ port: number; banner: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      void stop().then(() => reject(new Error("hub did not start within 15s")));
    }, 15_000);
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = /lucid hub listening on http:\/\/127\.0\.0\.1:(\d+)([^\n]*)/.exec(buf);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve({ port: Number.parseInt(m[1], 10), banner: m[0] });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      void rm(dir, { recursive: true, force: true })
        .catch(() => {})
        .then(() => reject(new Error(`hub exited early (${code}): ${buf}`)));
    });
  });
  const local: LocalHub = { port: started.port, banner: started.banner, dir, stop };
  localHubs.push(local);
  return local;
};

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
  await Promise.all(localHubs.splice(0).map((local) => local.stop()));

  // The hub `lucid app` started is DETACHED - nothing in this process is its
  // parent, so nothing reaps it when the test ends. It has to be signalled by
  // pid, and the kill has to be verified: a hub still holding 127.0.0.1:<port>
  // outlives the whole run and hijacks the next one.
  if (appHub) {
    const { port, dir } = appHub;
    let { pid } = appHub;
    appHub = undefined;
    // A failure BEFORE the test recorded the pid must not convert into a
    // leak: the descriptor the hub writes may already be on disk, so read it
    // here - before the rm below destroys the only copy - and reap by it.
    if (pid === undefined) {
      try {
        const descriptor = JSON.parse(await readFile(join(dir, "plan", "server.json"), "utf8")) as {
          pid?: number;
        };
        pid = descriptor.pid;
      } catch {
        /* the hub never hosted a session; the port probe below still verifies */
      }
    }
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && (await hubGet(port, "/hub/identity"))) {
        await new Promise((r) => setTimeout(r, 100));
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* the SIGTERM took, which is the normal path */
      }
    }
    await rm(dir, { recursive: true, force: true });
    expect(
      await hubGet(port, "/hub/identity"),
      `the hub \`lucid app\` spawned on ${port} is still running`,
    ).toBeUndefined();
  }
});

test("a picker row that cannot open says so on itself and keeps the pick screen", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  // End the session so the hub releases its mount: a mounted session answers
  // its identity route out of memory, which would make the deleted log
  // invisible and the whole scenario unexhibitable. The registry pointer -
  // and therefore the picker row - survives, because the artifact does.
  const descriptor = join(cli.dir, "plan", "server.json");
  await cli.run(["end", cli.artifact]);
  await expect
    .poll(
      async () =>
        stat(descriptor).then(
          () => true,
          () => false,
        ),
      {
        message: "the hub never released its mount, so the deleted log stays invisible",
      },
    )
    .toBe(false);

  await page.goto(hub.url);
  const row = on(page).pickerRow();
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Migration plan");
  await expect(on(page).shellTab()).toHaveCount(0);

  // The record goes out from under the row.
  await rm(join(cli.dir, "plan", "log.ndjson"));
  await row.click();

  // The row reports on ITSELF - and that text arriving is the settle signal
  // for the two absences below: the click has been fully answered, so a tab
  // that was going to be created would exist by now.
  await expect(row).toContainText("couldn't open - is the session's log readable?");
  await expect(on(page).shellTab()).toHaveCount(0);
  await expect(on(page).pickerRow()).toHaveCount(1);
});

test("open --restart on a hub-hosted session leaves the hub and the other tab alive", async () => {
  hub = await startHub();
  const first = await openIntoHub(hub, PLAN_V1);
  cli = first.cli;
  // A second artifact in the SAME folder, so both sit in one project and one
  // tab strip - the blast radius of a restart is the whole hub, not a project.
  const second = join(cli.dir, "rollout.html");
  await writeFile(second, PLAN_V1.replace("Database migration plan", "Rollout checklist"), "utf8");
  await cli.run(["open", second]);

  const before = await hubGet(hub.port, "/hub/identity");
  expect(before?.port).toBe(hub.port);
  // The hub's OWN pid, as it wrote it into the session it hosts. `/hub/identity`
  // does not carry one, and "the port still answers" alone would be satisfied
  // by a different process that took the port.
  const secondDescriptor = join(cli.dir, "rollout", "server.json");
  const hubPid = JSON.parse(await readFile(secondDescriptor, "utf8")) as {
    pid: number;
    base?: string;
  };
  // A descriptor with a `base` is the shared daemon's, which is the only shape
  // this scenario is about - without one, `stopServer` has nothing to refuse.
  expect(hubPid.base, "the second session is not hub-hosted, so this proves nothing").toMatch(
    /^\/s\/.+/,
  );

  await cli.run(["open", cli.artifact, "--restart"]);

  const after = await hubGet(hub.port, "/hub/identity");
  expect(after, "`open --restart` killed the hub").toBeDefined();
  expect(after?.port).toBe(hub.port);
  const stillHosted = JSON.parse(await readFile(secondDescriptor, "utf8")) as { pid: number };
  expect(stillHosted.pid, "the hub was replaced, not left alone").toBe(hubPid.pid);

  // Both sessions still answer THROUGH the hub - a live round trip each, not
  // just a descriptor that has not been cleaned up yet. Independent sessions,
  // asked concurrently.
  const [secondState, firstState] = (await Promise.all([
    cli.run(["wait", second, "--timeout", waitTimeoutSeconds(2)]),
    cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(2)]),
  ])) as Record<string, unknown>[];
  expect(secondState?.session).toBe(second);
  expect(firstState?.session).toBe(cli.artifact);
});

test("only LUCID_HUB_ATTEND=1 turns on agent spawning", async () => {
  const create = async (port: number): Promise<number> => {
    const res = await loopbackFetch(port, "/hub/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Deliberately invalid: on an attend hub the name check refuses it with
      // 400 before anything is spawned, so this probe distinguishes "refused
      // because review-only" (403) from "refused because bad request" (400)
      // without ever starting an agent.
      body: JSON.stringify({}),
    });
    return res.status;
  };

  // Three independent hubs - own dirs, own ephemeral ports - so they start
  // concurrently and only the assertions are ordered.
  const [asTrue, asYes, opted] = await Promise.all([
    startHubWithEnv({ LUCID_HUB_ATTEND: "true" }),
    startHubWithEnv({ LUCID_HUB_ATTEND: "yes" }),
    startHubWithEnv({ LUCID_HUB_ATTEND: "1" }),
  ]);

  for (const [value, local] of [
    ["true", asTrue],
    ["yes", asYes],
  ] as const) {
    const identity = await hubGet(local.port, "/hub/identity");
    expect(identity?.attend, `LUCID_HUB_ATTEND=${value} enabled spawning`).toBe(false);
    // The startup line is the other half of the promise: a review-only hub
    // must not announce a mode it is not in.
    expect(local.banner).not.toContain("attend mode");
    expect(await create(local.port), `LUCID_HUB_ATTEND=${value} let /hub/create through`).toBe(403);
  }

  const identity = await hubGet(opted.port, "/hub/identity");
  expect(identity?.attend, "the explicit opt-in did not take").toBe(true);
  expect(opted.banner).toContain("attend mode: headless turns enabled");
  // Not 403: the route is open. 400 because the body is invalid, which is
  // where an attend hub refuses - and nothing was spawned to get that answer.
  expect(await create(opted.port)).toBe(400);
});

test("launch without a harness registry names the file to create and shows a complete one", async () => {
  cli = await makeCli(PLAN_V1);
  // `launch` checks the session before the registry, so without this the
  // refusal under test is never reached.
  await cli.run(["open", cli.artifact]);

  const failure = await cli.run(["launch", cli.artifact]).then(
    (doc) => new Error(`launch succeeded with no registry: ${JSON.stringify(doc)}`),
    (err: unknown) => err,
  );
  expect(failure, "launch did not fail").toBeInstanceOf(CliFailure);
  const cliFailure = failure as CliFailure;
  expect(cliFailure.code).toBe(1);

  const envelope = JSON.parse(cliFailure.stdout) as {
    error: {
      code: string;
      message: string;
      detail: { path?: string; example?: { harnesses?: Record<string, { spawn?: unknown }> } };
    };
  };
  expect(envelope.error.code).toBe("VALIDATION_ERROR");
  // The path it actually resolved, not a generic "~/.config/lucid": the harness
  // points LUCID_HARNESSES at a file inside the test's own dir that does not
  // exist, and that is the file a person would have to create.
  const expected = join(cli.dir, "harnesses.json");
  expect(envelope.error.message).toContain(expected);
  expect(envelope.error.detail.path).toBe(expected);

  // A complete registry, not a fragment: at least one named harness carrying a
  // spawn recipe, which is what makes the message actionable without the docs.
  const example = envelope.error.detail.example;
  const recipes = Object.values(example?.harnesses ?? {});
  expect(recipes.length, "detail.example names no harness").toBeGreaterThan(0);
  const spawnRecipe = recipes[0]?.spawn;
  expect(Array.isArray(spawnRecipe), "the example harness has no spawn recipe").toBe(true);
  expect((spawnRecipe as unknown[]).length).toBeGreaterThan(0);
});

test("a rendered plan opens, anchors on its D-NNN ids, and ingests back", async ({ page }) => {
  cli = await makeCli(PLAN_V1);
  const doc = join(cli.dir, "impl.md");
  // The markdown convention the REAL renderer recognises: a `<!-- D-NNN -->`
  // block comment ids the element that follows it (src/plan/render.ts).
  await writeFile(
    doc,
    [
      "# Backfill and cutover",
      "",
      "## Decisions",
      "",
      "<!-- D-004 -->",
      "",
      "The backfill runs nightly until row counts match, then reads cut over.",
      "",
      "## Open Questions",
      "",
      "1. Who owns the cutover window?",
      "",
    ].join("\n"),
    "utf8",
  );

  const title = "Rollout risk register";
  const rendered = (await cli.run([
    "plan",
    "render",
    doc,
    "--out",
    cli.artifact,
    "--title",
    title,
    "--stage",
    "build",
  ])) as { artifact: string };
  expect(rendered.artifact).toBe(cli.artifact);

  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  await page.goto(session.url);
  const surface = surfaceOf(page);
  // Both of the things `render`'s flags promised are in the document itself.
  // The stage is on screen; the title is the document's own <title>, read
  // through `textContent` because a head element has no rendered text and
  // `toHaveText` measures the rendered kind.
  await expect(surface.locator(".eyebrow")).toHaveText("Plan review · build");
  expect(await surface.locator("title").textContent()).toBe(title);

  const decision = inArtifact(surface).byLucidId("D-004");
  await expect(decision).toBeVisible();

  // The cursor an agent holds BEFORE the annotation exists, so the wait below
  // takes delivery of exactly this note.
  const before = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(1)])) as {
    nextCursor: string;
  };

  await decision.click();
  await on(page).annotationNote().fill("Nightly is too slow for the parity window.");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  const payload = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    before.nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { status: string };
  expect(payload.status).toBe("feedback");
  const payloadFile = join(cli.dir, "payload.json");
  await writeFile(payloadFile, JSON.stringify(payload), "utf8");

  const ingested = (await cli.run([
    "plan",
    "ingest",
    "--plan",
    "myplan",
    "--payload",
    payloadFile,
  ])) as {
    plan: string;
    items: { kind: string; ref?: string; note: string }[];
    commands: string[];
  };
  expect(ingested.plan).toBe("myplan");
  const feedback = ingested.items.find((i) => i.kind === "decision-feedback");
  expect(feedback, `no decision-feedback item in ${JSON.stringify(ingested.items)}`).toBeDefined();
  expect(feedback?.ref).toBe("D-004");
  expect(
    ingested.commands.some((c) => c.includes("add-finding") && c.includes("re D-004")),
    `no add-finding referencing D-004 in ${JSON.stringify(ingested.commands)}`,
  ).toBe(true);
});

test("lucid app brings up a hub that actually drives delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lucid-app-e2e-"));
  const port = await freePort();
  // LUCID_NO_OPEN is already in harnessEnv, so no browser window opens; the
  // hub `app` spawns inherits this env, which is what keeps its scan and its
  // registry inside the test's dir instead of the developer's ~/dev.
  const env = { ...harnessEnv(dir), LUCID_HUB_PORT: String(port), LUCID_HUB_ROOTS: dir };
  appHub = { dir, port };

  // `invoke` throws a CliFailure carrying code/stdout/stderr on any exit but
  // a clean JSON document, which is exactly the assertion the raw spawn made
  // by hand.
  const started = (await invoke(["app"], { cwd: dir, env, timeout: 30_000 })) as {
    status: string;
  };
  expect(started.status).toBe("running");

  // The pid first, and before any assertion that can fail: the hub is detached,
  // so a failure between here and `afterEach` with no pid recorded leaks a
  // process for the rest of the run. It comes out of the descriptor the hub
  // writes for a session it hosts, which is the product's own way of naming
  // the process behind a mount.
  const artifact = join(dir, "plan.html");
  await writeFile(artifact, PLAN_V1, "utf8");
  await invoke(["open", artifact], { cwd: dir, env, timeout: 30_000 });
  const descriptor = JSON.parse(await readFile(join(dir, "plan", "server.json"), "utf8")) as {
    pid: number;
    base?: string;
  };
  expect(descriptor.base, "the app's hub did not host the session").toBeTruthy();
  appHub = { dir, port, pid: descriptor.pid };

  const identity = await hubGet(port, "/hub/identity");
  expect(identity, `nothing answered on ${port} after lucid app`).toBeDefined();
  // The assertion the scenario exists for: the app front door is a human
  // sitting down to review, so the hub it starts drives delivery rather than
  // leaving feedback waiting for someone to re-summon a conversation.
  expect(identity?.attend, "`lucid app` started a review-only hub").toBe(true);
});
