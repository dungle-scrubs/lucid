import { on } from "./locators.ts";
import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { CliFailure } from "./cli-result.ts";
import { delayRoute } from "./routes.ts";
import { makeCli, openIntoHub, PLAN_V1, startHub, type Cli, type Hub } from "./helpers.ts";

/**
 * The shell and the CLI against routes that answer badly or late (M5.1).
 *
 * Two of these are about a screen telling the truth WHILE it waits - the
 * hardest state to get right, because it only exists between a request and
 * its answer, and the honest word there ("looking") is different from the
 * honest word after ("empty"). The third is the CLI's own fallback when the
 * server it found turns out to be older than the route it wanted.
 */

let hub: Hub | undefined;
let cli: Cli | undefined;

test.afterEach(async () => {
  await cli?.cleanup();
  cli = undefined;
  await hub?.stop();
  hub = undefined;
});

test("before the first listing arrives the screen says it is LOOKING, not empty", async ({
  page,
}) => {
  hub = await startHub();
  const opened = await openIntoHub(hub, PLAN_V1);
  cli = opened.cli;

  // The listing stream held back, so the pre-snapshot state is a place the
  // test can stand rather than a frame it has to catch.
  await delayRoute(page, "**/hub/events", 3000);
  await page.goto(hub.url);

  // "Looking" is the truth while nothing has answered. "No reviews here yet"
  // in this window is a claim the shell cannot support - and it is the one
  // that makes a person go and check whether their session is broken.
  // The looking state is the assertion. The "No reviews here yet" absence
  // that used to sit here could not fail - this hub HAS a session, so that
  // string never renders whichever state the shell is in, and an assertion
  // that cannot fail is decoration.
  await expect(page.getByText("Looking for sessions…")).toBeVisible();
  // ...and nothing has been offered yet, which is what "still asking" means.
  await expect(on(page).pickerRow()).toHaveCount(0);

  // ...and when the snapshot lands, the looking state gives way to the real
  // answer. Asserting the transition is what keeps this from passing against
  // a screen that says "Looking" forever.
  await expect(on(page).pickerRow()).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByText("Looking for sessions…")).toHaveCount(0);
});

test("with no OS chooser the folder icon falls back to a path field", async ({ page }) => {
  hub = await startHub();
  cli = await makeCli(PLAN_V1);
  await cli.run(["open", cli.artifact]);

  // 501 for the CHOOSER call only - the request with no path, which is how
  // the client asks the OS to open a picker. A build without one answers
  // 501; the same route with a path is a plain add and must still work,
  // which is the whole point of the fallback.
  await page.route("**/hub/roots", async (route) => {
    const body = route.request().postData() ?? "";
    if (body.includes("path")) return route.continue();
    return route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "no native chooser on this build" }),
    });
  });
  await page.goto(hub.url);
  await expect(page.locator("code", { hasText: hub.dir })).toBeVisible();

  await on(page).addFolder().first().click();
  const field = on(page).addFolderPath().first();
  await expect(field, "a 501 left the human with no way to name a folder").toBeVisible();

  // Typing the path completes the job the chooser could not start. The
  // listing arriving is the proof - a fallback that renders a field and
  // then swallows what is typed into it is the dead end it replaced.
  await field.fill(cli.dir);
  await on(page).addFolderPathAdd().first().click();
  await expect(on(page).pickerRow()).toHaveCount(1, { timeout: 20_000 });
  await expect(on(page).pickerRow().first()).toContainText("Migration plan");
});

test("a server without /__lucid/context falls through to the sidecar, and says live:false", async () => {
  cli = await makeCli(PLAN_V1);
  await cli.run(["open", cli.artifact]);
  await cli.run(["end", cli.artifact]);

  // A stub server standing where an OLDER daemon would: it passes the
  // identity handshake, so the CLI finds it live, and 404s the context route
  // it predates. `page.route` cannot do this - the CLI is its own process,
  // and the request never passes through the browser.
  const seen: string[] = [];
  let stubPort = 0;
  const stub = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/__lucid/identity")) {
      // The REAL port, not a placeholder: the caller POSTs to whatever this
      // body reports, and a 0 here sends the request nowhere - which fails
      // the same way a 404 does and would have passed this test for the
      // wrong reason (measured: it did).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ lucid: true, session: cli?.artifact, port: stubPort, version: 1 }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such route on this build" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  stubPort = port;

  try {
    // Point the session's descriptor at the stub, so discovery hands the CLI
    // a server that answers the handshake and nothing else. The descriptor now
    // lives under run/ (plan 02, MB.1); ensure it exists since `end` may have
    // swept the runtime dir.
    await mkdir(join(cli.dir, "plan", "run"), { recursive: true });
    await writeFile(
      join(cli.dir, "plan", "run", "server.json"),
      JSON.stringify({
        port,
        pid: process.pid,
        session: cli.artifact,
        startedAt: new Date().toISOString(),
      }),
    );

    const reported = (await cli.run(["context", cli.artifact, "--pct", "55"])) as {
      ok: boolean;
      live: boolean;
      context: { pct?: number };
    };

    // The CLI found a live server and the POST 404'd, so the value went to
    // the sidecar - and `live` says so. Reporting live:true here would tell
    // an agent its usage reached a server that refused it.
    // The POST actually REACHED the stub and was refused there. Without this
    // the test passes when the handshake merely fails, which is a different
    // path with the same visible answer.
    expect(
      seen.some((r) => r.includes("/__lucid/context")),
      `the context POST never reached the stub: ${seen.join(", ")}`,
    ).toBe(true);
    expect(reported.ok).toBe(true);
    expect(reported.live, "a 404'd POST was reported as a live success").toBe(false);
    expect(reported.context.pct).toBe(55);

    // ...and the fallback actually WROTE. `live:false` with no sidecar would
    // be the same lie wearing the other label.
    const sidecar = JSON.parse(
      await readFile(join(cli.dir, "plan", "run", "context.json"), "utf8"),
    ) as {
      pct?: number;
    };
    expect(sidecar.pct).toBe(55);
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("a refusal from `context` is still a typed refusal, not a quiet ok", async () => {
  cli = await makeCli(PLAN_V1);
  await cli.run(["open", cli.artifact]);

  // The other half of the same contract: no usable numbers is a VALIDATION
  // refusal with a non-zero exit, not an ok:false the shell reads as success
  // (the M2.2 invariant, asserted here where `context`'s fallback lives).
  const refused = await cli.run(["context", cli.artifact]).then(
    () => undefined,
    (error: unknown) => error as CliFailure,
  );
  expect(refused).toBeInstanceOf(CliFailure);
  expect(refused?.code).toBe(1);
  const envelope = JSON.parse(refused?.stdout ?? "{}") as { error?: { code?: string } };
  expect(envelope.error?.code).toBe("VALIDATION_ERROR");
});
