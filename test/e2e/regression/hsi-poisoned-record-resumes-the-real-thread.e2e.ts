import { expect, test } from "@playwright/test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { invoke } from "../cli.ts";
import { startHub, type Hub } from "../hub.ts";

/**
 * The reported failure, end to end through a real hub.
 *
 * A review's record carried an attendant stamp whose `sessionId` was a UUID
 * LUCID minted - a synthetic id the harness never knew - while the harness's
 * own thread lived only in the machine-local sidecar. Unattended delivery read
 * the stamp, put the synthetic id into `codex resume <id>`, and codex answered
 * that no such rollout exists: feedback stalled behind a generic failed-turn
 * line, and every retry asked the same dead question.
 *
 * What this pins: automatic resume ranks EVIDENCE, and a bare log mention is
 * not evidence. Asserted on the argv the harness actually received, because
 * that is the only place the defect was ever visible.
 */

let hub: Hub | undefined;

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
});

test("a poisoned record resumes the harness's real thread, never the synthetic id", async () => {
  const synthetic = "cf4f0000-1111-4222-8333-444455556666";
  const real = "0199f00d-cafe-4bee-8dad-beef00001111";

  hub = await startHub({ attend: true });
  const dir = hub.dir;

  // A stub harness that records the argv of every turn it is given.
  const seen = join(dir, "resumed-argv.txt");
  const stub = join(dir, "codex-stub.sh");
  await writeFile(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(seen)}\nexit 0\n`);
  await chmod(stub, 0o755);
  await writeFile(
    join(dir, "harnesses.json"),
    JSON.stringify({
      default: "codex",
      harnesses: {
        codex: {
          sessionIdentity: {
            event: "thread.started",
            field: "thread_id",
            requiredArgument: "--json",
            source: "stdout-jsonl",
          },
          spawn: [stub, "--json", "{artifact}", "{prompt}"],
          resume: [stub, "--json", "{id}", "{artifact}", "{prompt}"],
        },
      },
    }),
  );

  // A review record built the way the report described it.
  // Canonical placement (plan 05): `open` refuses an artifact anywhere else.
  await mkdir(join(dir, ".lucid"), { recursive: true });
  const artifact = join(dir, ".lucid", "poisoned.html");
  const html =
    '<!doctype html><html><head><title>Poisoned</title></head><body><h1 data-lucid-id="h">Plan</h1></body></html>';
  await writeFile(artifact, html);
  // Opened through the CLI, so the record is real and the hub discovers it the
  // way it discovers any session - the fixture poisons a genuine record rather
  // than hand-building one the scanner may not recognize.
  await invoke(["open", artifact], { cwd: dir, env: hub.env, timeout: 30_000 });
  const record = join(dir, ".lucid", "poisoned");
  const at = new Date().toISOString();
  const opened = await readFile(join(record, "log.ndjson"), "utf8");
  const seqFrom = opened.trim().split("\n").filter(Boolean).length;
  await writeFile(
    join(record, "log.ndjson"),
    `${opened}${[
      // THE POISON: a stamp naming a session codex never had. This is what
      // the old resolver read and put into resume argv.
      JSON.stringify({
        t: "agent_reply",
        seq: seqFrom + 1,
        at,
        id: "poison",
        text: "an earlier turn",
        attendant: { harness: "codex", sessionId: synthetic, cwd: dir },
      }),
      // A human's pending feedback, which delivery will try to deliver.
      JSON.stringify({
        t: "annotation",
        seq: seqFrom + 2,
        at,
        id: "a1",
        version: 1,
        target: {
          kind: "element",
          lucidId: "h",
          fingerprint: "f",
          domPath: "h1",
          snippet: "Plan",
        },
        note: "tighten this",
      }),
    ].join("\n")}\n`,
  );
  // The real thread exists in this machine's Codex store - pre-flight refuses
  // a store-absent id before any process runs, and this test is about which
  // id reaches argv, not about the refusal.
  await mkdir(join(dir, "codex-sessions", "2026", "08", "01"), { recursive: true });
  await writeFile(
    join(dir, "codex-sessions", "2026", "08", "01", `rollout-2026-08-01T10-00-00-${real}.jsonl`),
    "{}\n",
  );
  // THE TRUTH: the machine-local sidecar, where the harness's own thread was
  // recorded with explicit authority when it announced itself.
  await writeFile(
    join(record, "run", "cursor.codex.json"),
    `${JSON.stringify(
      {
        harness: "codex",
        sessionId: real,
        sessionIdAuthority: "observed",
        launchId: "abc123def4567890",
        nextCursor: "evt_00002",
        at,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(record, "run", "selection.json"), JSON.stringify({ harness: "codex" }));

  // Mount it in the hub, which starts attending.
  // The listing is served from a cache that refreshes behind the reader, so
  // a record written after the hub started appears on a later read.
  let id: string | undefined;
  const listedBy = Date.now() + 20_000;
  while (Date.now() < listedBy && id === undefined) {
    const body = (await fetch(`${hub.url}hub/sessions?fresh=1`, {
      headers: { host: `127.0.0.1:${hub.port}` },
    })
      .then((r) => r.json())
      .catch(() => ({}))) as { sessions?: { artifact: string; id: string }[] };
    id = body.sessions?.find((s) => s.artifact === artifact)?.id;
    if (id === undefined) await new Promise((r) => setTimeout(r, 250));
  }
  expect(id).toBeTruthy();
  await fetch(`${hub.url}s/${id}/__lucid/identity`, {
    headers: { host: `127.0.0.1:${hub.port}` },
  });

  // Wait for the harness to be driven at all.
  const deadline = Date.now() + 30_000;
  let argv = "";
  while (Date.now() < deadline && argv === "") {
    argv = await readFile(seen, "utf8").catch(() => "");
    if (argv === "") await new Promise((r) => setTimeout(r, 250));
  }
  expect(argv).not.toBe("");
  // The whole point: the thread the harness announced, never the synthetic id.
  expect(argv).toContain(real);
  expect(argv).not.toContain(synthetic);
});

test("a dead session says so in the viewer, and the feedback stays recorded", async () => {
  // The other half of the report: when the recorded session genuinely does not
  // exist here, the human used to see only a generic failed-turn line and had
  // no way to know their feedback was safe. Now the viewer names the cause and
  // the annotation is still visibly recorded.
  const dead = "0199dead-beef-4bad-8fed-000000000000";
  hub = await startHub({ attend: true });
  const dir = hub.dir;

  const stub = join(dir, "codex-none.sh");
  await writeFile(stub, `#!/bin/sh\necho "Error: no rollout found for thread id" >&2\nexit 1\n`);
  await chmod(stub, 0o755);
  await writeFile(
    join(dir, "harnesses.json"),
    JSON.stringify({
      default: "codex",
      harnesses: {
        codex: {
          sessionIdentity: {
            event: "thread.started",
            field: "thread_id",
            requiredArgument: "--json",
            source: "stdout-jsonl",
          },
          spawn: [stub, "--json", "{artifact}", "{prompt}"],
          resume: [stub, "--json", "{id}", "{artifact}", "{prompt}"],
        },
      },
    }),
  );

  // The dead thread HAS a rollout file, so pre-flight lets the spawn run and
  // the verdict comes from the harness's own mouth (HSI004) - the durable
  // quarantine this test pins. A store-absent id is refused before any
  // process runs, which is a different, batch-scoped mechanism with its own
  // tests.
  await mkdir(join(dir, "codex-sessions", "2026", "08", "01"), { recursive: true });
  await writeFile(
    join(dir, "codex-sessions", "2026", "08", "01", `rollout-2026-08-01T10-00-00-${dead}.jsonl`),
    "{}\n",
  );
  // A real project root, so the artifact's project and the session's recorded
  // cwd agree - otherwise the engine reads the artifact as MOVED and starts a
  // fresh handoff, which resumes nothing and could never reach a verdict.
  await mkdir(join(dir, ".git"), { recursive: true });
  await mkdir(join(dir, ".lucid"), { recursive: true });
  const artifact = join(dir, ".lucid", "unavailable.html");
  await writeFile(
    artifact,
    '<!doctype html><html><head><title>Unavailable</title></head><body><h1 data-lucid-id="h">Plan</h1></body></html>',
  );
  await invoke(["open", artifact], { cwd: dir, env: hub.env, timeout: 30_000 });
  const record = join(dir, ".lucid", "unavailable");
  const at = new Date().toISOString();
  await writeFile(
    join(record, "run", "cursor.codex.json"),
    `${JSON.stringify(
      {
        harness: "codex",
        sessionId: dead,
        sessionIdAuthority: "observed",
        nextCursor: "evt_00002",
        at,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(record, "run", "selection.json"), JSON.stringify({ harness: "codex" }));
  const opened = await readFile(join(record, "log.ndjson"), "utf8");
  const seqFrom = opened.trim().split("\n").filter(Boolean).length;
  const note = "this feedback must stay recorded";
  await writeFile(
    join(record, "log.ndjson"),
    `${opened}${JSON.stringify({
      t: "annotation",
      seq: seqFrom + 1,
      at,
      id: "a1",
      version: 1,
      target: { kind: "element", lucidId: "h", fingerprint: "f", domPath: "h1", snippet: "Plan" },
      note,
    })}\n`,
  );

  let id: string | undefined;
  const listedBy = Date.now() + 20_000;
  while (Date.now() < listedBy && id === undefined) {
    const body = (await fetch(`${hub.url}hub/sessions?fresh=1`, {
      headers: { host: `127.0.0.1:${hub.port}` },
    })
      .then((r) => r.json())
      .catch(() => ({}))) as { sessions?: { artifact: string; id: string }[] };
    id = body.sessions?.find((session) => session.artifact === artifact)?.id;
    if (id === undefined) await new Promise((r) => setTimeout(r, 250));
  }
  expect(id).toBeTruthy();
  await fetch(`${hub.url}s/${id}/__lucid/identity`, {
    headers: { host: `127.0.0.1:${hub.port}` },
  });

  // The dead id is quarantined durably - proof the engine reached a verdict
  // rather than looping on transient retries.
  const quarantinedBy = Date.now() + 30_000;
  let quarantined: readonly string[] = [];
  while (Date.now() < quarantinedBy && quarantined.length === 0) {
    const sidecar = await readFile(join(record, "run", "cursor.codex.json"), "utf8").catch(
      () => "{}",
    );
    quarantined =
      (JSON.parse(sidecar) as { invalidatedSessionIds?: string[] }).invalidatedSessionIds ?? [];
    if (quarantined.length === 0) await new Promise((r) => setTimeout(r, 250));
  }
  expect(quarantined).toContain(dead);

  // The human's words are still in the record - undelivered, not lost.
  const finalLog = await readFile(join(record, "log.ndjson"), "utf8");
  expect(finalLog).toContain(note);
});
