import { expect, test } from "@playwright/test";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliFailure } from "./cli-result.ts";
// `invoke` is off the barrel because it takes a raw env; this file is the
// case that scoping names - the stub hub below must be discoverable, and the
// `cli` fixture deliberately pins LUCID_HUB_PORT at a dead one.
import { invoke } from "./cli.ts";
import { harnessEnv } from "./harness-env.ts";
import { killSessionServer, makeCli, PLAN_V1, waitTimeoutSeconds, type Cli } from "./helpers.ts";

/**
 * What happens when the server behind a session dies without saying goodbye
 * (M5.2, kill-server).
 *
 * A crash is not a shutdown: nothing runs, no descriptor is cleaned up, no
 * event is appended. So every one of these asserts the same shape from a
 * different angle - the CLI notices by HANDSHAKE rather than by trusting what
 * is on disk, says so in a way an agent can act on, and never leaves a second
 * writer behind. `killSessionServer` refuses to fire on a stale descriptor for
 * exactly that reason, so the kills here are all against sessions that just
 * answered.
 */

let cli: Cli | undefined;
/** Artifacts opened BESIDE `cli.artifact`. `cleanup()` ends only the one it
 *  made, so a second session opened here would outlive the test as a live
 *  `__serve` - which the global teardown reports as a leak, correctly. */
let alsoOpened: string[] = [];

test.afterEach(async () => {
  for (const artifact of alsoOpened) {
    try {
      await cli?.run(["end", artifact]);
    } catch {
      /* already gone - this is the crash suite, several are meant to be */
    }
  }
  alsoOpened = [];
  await cli?.cleanup();
  cli = undefined;
});

const opened = async (html = PLAN_V1): Promise<{ cursor: string }> => {
  cli = await makeCli(html);
  const session = (await cli.run(["open", cli.artifact])) as { nextCursor: string };
  return { cursor: session.nextCursor };
};

test("a dead server makes wait return suspended, well before its timeout", async () => {
  const { cursor } = await opened();
  if (!cli) throw new Error("no cli");
  await killSessionServer(cli.artifact);

  // The deadline is generous on purpose: the claim is that `wait` notices the
  // server is gone and returns EARLY, so a run that only just beats the
  // timeout would be indistinguishable from one that hung until it.
  const started = Date.now();
  const answer = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    cursor,
    "--timeout",
    waitTimeoutSeconds(20),
  ])) as { status: string };
  const elapsed = Date.now() - started;

  expect(answer.status).toBe("suspended");
  // Comfortably inside the deadline. An agent polling a dead session must be
  // told to stop rather than burn its turn - that is the whole point of the
  // liveness handshake being in the wait loop at all.
  expect(elapsed, `wait took ${elapsed}ms to notice a dead server`).toBeLessThan(15_000);
});

test("end after the server already died still clears the descriptor", async () => {
  await opened();
  if (!cli) throw new Error("no cli");
  const descriptor = join(cli.dir, "plan", "server.json");
  await killSessionServer(cli.artifact);

  // The descriptor outlived its process - that is what a crash leaves. `end`
  // must clean it up anyway, or the next listing reports a live session
  // pointing at a port nothing is on.
  const ended = (await cli.run(["end", cli.artifact])) as { status: string };
  expect(ended.status).toBe("ended");
  await expect(readFile(descriptor, "utf8")).rejects.toThrow();

  // And the listing agrees: no ghost.
  const listing = (await cli.run([])) as { sessions: { session: string; live?: boolean }[] };
  const row = listing.sessions.find(
    (s) => realpathSync(String(s.session)) === realpathSync(String(cli?.artifact)),
  );
  expect(row?.live ?? false).toBe(false);
});

test("a question asked while the server is down survives to the next open", async () => {
  await opened();
  if (!cli) throw new Error("no cli");
  await killSessionServer(cli.artifact);

  // No server to POST through, so this takes the direct log-append path. The
  // agent's side must not fail just because nobody is watching.
  await cli.run(["ask", cli.artifact, "--text", "Which store are we cutting over to?"]);

  // The question is in the record, and the record is what a reopen reads.
  const reopened = (await cli.run(["open", cli.artifact])) as { nextCursor: string };
  expect(reopened.nextCursor).toBeDefined();
  const state = (await cli.run(["wait", cli.artifact, "--timeout", waitTimeoutSeconds(2)])) as {
    questions?: { text: string }[];
  };
  expect(state.questions?.some((q) => q.text.includes("cutting over"))).toBe(true);
});

test("an edit made while nobody was serving becomes v2 on the next open", async () => {
  await opened();
  if (!cli) throw new Error("no cli");
  await killSessionServer(cli.artifact);

  // Edited with no watcher running: nothing observed this change, so the only
  // chance to notice it is the reconciliation the next open performs.
  await cli.write(PLAN_V1.replace("nightly", "in one batch, with row-count verification"));

  const reopened = (await cli.run(["open", cli.artifact])) as { version: number };
  expect(reopened.version, "an out-of-band edit was not reconciled on reopen").toBe(2);

  // ...and the older version is still there to compare against - the point of
  // versioning an edit nobody watched is that it stays reviewable.
  const v1 = join(cli.dir, "plan", "versions", "s1", "v1.html");
  expect((await readFile(v1, "utf8")).includes("nightly")).toBe(true);
});

test("a truncated artifact on resume warns instead of committing a broken version", async () => {
  await opened();
  if (!cli) throw new Error("no cli");
  await killSessionServer(cli.artifact);

  // A half-written file, the way an interrupted save leaves one.
  await cli.write(PLAN_V1.slice(0, Math.floor(PLAN_V1.length / 2)));

  const reopened = (await cli.run(["open", cli.artifact])) as {
    version: number;
    warnings?: { code: string }[];
  };

  // Exit 0 with a warning, NOT a refusal and NOT a commit: the human still
  // gets their session, and the broken bytes do not become a version anyone
  // can revert to.
  expect(reopened.warnings?.some((w) => w.code === "STRUCTURE_INVALID")).toBe(true);
  expect(reopened.version, "a structurally invalid artifact was committed as a version").toBe(1);

  // The last good bytes are still what gets served.
  const current = await readFile(join(cli.dir, "plan", "current.html"), "utf8");
  expect(current).toContain("</html>");
});

test("the listing puts live sessions first, then sorts by name", async () => {
  cli = await makeCli(PLAN_V1);
  // Three sessions in one folder: one alive, two not - and the two dead ones
  // named so that alphabetical order and liveness order disagree, which is
  // the only arrangement that can tell the two sorts apart.
  const alpha = join(cli.dir, "alpha.html");
  const zulu = join(cli.dir, "zulu.html");
  await writeFile(alpha, PLAN_V1, "utf8");
  await writeFile(zulu, PLAN_V1, "utf8");
  alsoOpened.push(alpha, zulu);
  await cli.run(["open", alpha]);
  await cli.run(["end", alpha]);
  await cli.run(["open", zulu]);
  await cli.run(["end", zulu]);
  await cli.run(["open", cli.artifact]); // plan.html, and left alive

  const listing = (await cli.run([])) as {
    sessions: { session: string; live?: boolean; viewer?: string; resume?: string }[];
  };
  const rows = listing.sessions;
  expect(rows.length).toBe(3);

  // Compared by realpath: the scan reports the spelling the OS hands back
  // (/private/tmp on macOS) while the fixture holds the one it was given -
  // one file, two spellings, which is the identity split the plan carries as
  // an open finding. The ORDER is the claim here, not the spelling.
  const same = (p: string): string => realpathSync(p);
  // The live one leads, even though its name sorts last of the three.
  expect(same(String(rows[0]?.session))).toBe(same(cli.artifact));
  expect(rows[0]?.live).toBe(true);
  // ...and the dead ones follow in name order, not open order (zulu was
  // opened after alpha, so open order would put it first).
  expect(rows.slice(1).map((r) => same(String(r.session)))).toEqual([same(alpha), same(zulu)]);

  // Each row carries the thing its state makes actionable: a live session is
  // something to LOOK at, a dead one is something to REOPEN.
  expect(rows[0]?.viewer).toBeDefined();
  expect(rows[1]?.resume).toContain("lucid open");
  expect(rows[1]?.viewer).toBeUndefined();
});

test("a hub that accepts a session and never serves it fails loudly, never split-brains", async () => {
  cli = await makeCli(PLAN_V1);

  // A stub hub that ACCEPTS the session and then never serves its mount -
  // exactly the state a hub crashing between accept and handshake leaves.
  // A real hub cannot be killed inside that window from outside the process
  // (it is one round trip wide), and the earlier version of this test killed
  // the hub BEFORE open, which never enters the branch at all: measured, it
  // passed with the split-brain guard removed.
  const stub = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.endsWith("/hub/identity")) {
      res.writeHead(200, { "content-type": "application/json" });
      // `lucid: "hub"` is what hubInfo checks for - anything else and the
      // CLI never takes the hub path at all, which is how the first version
      // of this test passed while exercising nothing.
      res.end(JSON.stringify({ lucid: "hub", shells: 0, attend: false }));
      return;
    }
    if (url.endsWith("/hub/open")) {
      // "I own this session now" - and then nothing ever answers the mount.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          id: "deadbeefdeadbeef",
          base: "/s/deadbeefdeadbeef",
          shell: "http://127.0.0.1:1/?s=deadbeefdeadbeef",
          shells: 0,
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the mount never answered" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const address = stub.address();
  const hubPort = typeof address === "object" && address !== null ? address.port : 0;

  try {
    // Pointed at the stub, which is the whole point: the fixture's own env
    // pins discovery at a dead port so no real hub can interfere.
    const failed = await invoke(["open", cli.artifact], {
      cwd: cli.dir,
      timeout: 40_000,
      env: { ...harnessEnv(cli.dir), LUCID_HUB_PORT: String(hubPort) },
    }).then(
      () => undefined,
      (error: unknown) => error as CliFailure,
    );

    // It MUST fail rather than quietly serve the session itself: the hub said
    // it owns this session, so a dedicated server behind that mount would be
    // a second appender on one log.
    expect(failed, "open silently took over a session the hub had accepted").toBeInstanceOf(
      CliFailure,
    );
    expect(failed?.code).toBe(1);
    const envelope = JSON.parse(failed?.stdout ?? "{}") as {
      error?: { code?: string; message?: string };
    };
    expect(envelope.error?.code).toBe("SERVER_ERROR");
    expect(envelope.error?.message).toContain("never answered");

    // And the proof there is no second writer: no descriptor was written.
    await expect(readFile(join(cli.dir, "plan", "server.json"), "utf8")).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});
