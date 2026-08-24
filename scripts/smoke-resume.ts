/**
 * Resume as its own lane.
 *
 * Establish a fact, lose the process, reopen the record, and ask the harness
 * to recall the fact from its OWN memory - the second prompt carries no
 * context, so a correct answer can only have come from a resumed session.
 * That is what separates this from cross-harness handoff, where the successor
 * cannot inherit a session it never had and learns the conversation from
 * lucid's record instead.
 *
 * PASSES for claude, pi, and codex since RFC-03. It fails for muse, and the
 * reason is below lucid: muse's identity event reports a session id that is
 * not a key in muse's own store, so hcn refuses the resume before spawn
 * (`no muse session <id> found at ~/.local/share/muse/sessions`). lucid
 * handles that correctly - RFC-03 R002 - by running the turn fresh and
 * recording why, so a stale hint costs the context and never the turn.
 *
 * Run: bun scripts/smoke-resume.ts [--harness claude]
 * Evidence: spikes/evidence/resume.md
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../src/harness/hcn-runner.js";
import { nodeHarnessDeps } from "../src/harness/node-deps.js";
import type { HarnessName } from "../src/harness/runner.js";
import { openHeadlessSession, openHeadlessTurns } from "../src/modes/headless.js";
import type { Frame } from "../src/protocol/index.js";
import { createConversationRecord, openConversation } from "../src/store/store.js";

const flagValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const HARNESS = (flagValue("--harness") ?? "claude") as HarnessName;
const BUDGET = Number(flagValue("--turn-budget") ?? "90000");
const CODEWORD = "pomegranate";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lines: string[] = [];
const log = (s: string) => {
  console.log(s);
  lines.push(s);
};
const doneCount = (evs: readonly { event: Record<string, unknown> }[]): number =>
  evs.filter((e) => e.event.kind === "done").length;
const textOf = (evs: readonly { event: Record<string, unknown> }[]): string =>
  evs
    .filter((e) => e.event.kind === "message")
    .map((e) => (typeof e.event.text === "string" ? e.event.text : ""))
    .join(" ");

const main = async (): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "lucid-resume-"));
  const conversationId = "res-1";
  const dir = join(root, conversationId);
  const { secret } = createConversationRecord(root, conversationId);
  const runner = createHcnRunner(nodeHarnessDeps());
  // One id for both halves: resuming means re-entering THIS session, which is
  // exactly what a fresh id would not do.
  const sessionId = crypto.randomUUID();
  let ok = true;

  log(`# resume - ${HARNESS}, sessionId ${sessionId}`);
  log(`record: ${dir}`);

  const hasSession = (await runner.inspect(HARNESS)).session;
  const open = (prefix: string) => {
    let receive: (f: Frame) => void = () => {};
    const host = openConversation(dir, {
      now: () => Date.now(),
      presence: () => undefined,
      // The smoke's in-process rig is the de-facto holder (R2).
      executorLease: () => true,
      onRecord: () => {},
      onEffect: (e) => {
        if (e.type === "send") receive(e.frame);
      },
    });
    let n = 0;
    const common = {
      harness: HARNESS,
      conversationId,
      secret,
      runner,
      mintTurnId: () => `${prefix}-${++n}`,
      sendFrame: (f: Frame) => host.handleFrame(JSON.stringify(f)),
    };
    // Turn mode carries resume itself: the strategy captures the session id
    // off the first turn's identity and resumes into it on the next process.
    // Session mode is given the id up front, which is a different thing -
    // see the evidence file.
    const source = hasSession
      ? openHeadlessSession({ ...common, sessionId })
      : openHeadlessTurns(common);
    receive = source.receive;
    return { host, source };
  };

  const waitForMore = async (
    host: ReturnType<typeof openConversation>,
    baseline: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + BUDGET;
    while (Date.now() < deadline) {
      if (doneCount(host.transcript().events) > baseline) return true;
      if (host.state().attachment === null) return false;
      await sleep(200);
    }
    return false;
  };

  // --- before the restart --------------------------------------------------
  log(`\n## establish, then lose the process`);
  const a = open("pre");
  a.host.enqueueInput({
    id: "in-1",
    text: `Remember this codeword: ${CODEWORD}. Reply with only: ok`,
    mode: "queue",
  });
  if (!(await waitForMore(a.host, 0))) {
    log("FAIL: the first turn did not complete");
    ok = false;
  }
  const seqBefore = a.host.state().seq;
  log(`first turn done; seq ${seqBefore}`);

  // Close the source, which ends the harness process. The record stays.
  a.source.close();
  await sleep(2000);
  log(`source closed; attachment ${a.host.state().attachment === null ? "released" : "HELD"}`);
  if (a.host.state().attachment !== null) ok = false;

  // --- after the restart ---------------------------------------------------
  log(`\n## reopen the record and resume the same session`);
  const b = open("post");
  const foldedSeq = b.host.state().seq;
  log(`folded: seq ${foldedSeq}, events ${b.host.transcript().events.length}`);
  if (foldedSeq < seqBefore) {
    log("FAIL: the fold lost work from before the restart");
    ok = false;
  }

  // The prompt carries NO context. If the codeword comes back, it came from
  // the harness's own resumed session, not from anything lucid re-sent.
  const baseline = doneCount(b.host.transcript().events);
  b.host.enqueueInput({
    id: "in-2",
    text: "Reply with only the codeword I gave you earlier.",
    mode: "queue",
  });
  if (!(await waitForMore(b.host, baseline))) {
    log("FAIL: the turn after resume did not complete");
    ok = false;
  }
  const after = b.host.transcript().events.filter((e) => String(e.turnId ?? "").startsWith("post"));
  const recovered = textOf(after).toLowerCase().includes(CODEWORD);
  log(`answered; codeword recalled by the harness itself: ${recovered}`);
  if (!recovered) ok = false;

  b.source.close();
  await sleep(1500);
  const reopened = openConversation(dir, {
    now: () => Date.now(),
    presence: () => undefined,
    executorLease: () => false,
    onRecord: () => {},
    onEffect: () => {},
  });
  const ids = [...new Set(reopened.transcript().events.map((e) => e.turnId))];
  const bothHalves =
    ids.some((i) => i?.startsWith("pre")) && ids.some((i) => i?.startsWith("post"));
  log(`\n## one record across the restart`);
  log(`turnIds: ${ids.join(", ")}`);
  log(`both halves in one fold: ${bothHalves}`);
  if (!bothHalves) ok = false;

  mkdirSync("spikes/evidence", { recursive: true });
  writeFileSync(
    "spikes/evidence/resume.md",
    [
      `# Resume - ${HARNESS}`,
      "",
      "Generated by `bun scripts/smoke-resume.ts`. Rewritten whole on every",
      "run - do not hand-edit.",
      "",
      "## What this proves",
      "",
      "A conversation survives losing its process, and so does the harness's",
      "own context. The record is reopened, lucid finds the session THIS",
      "harness last held in it, and the harness answers from that session -",
      "the second prompt carries no context at all.",
      "",
      "Finding it needs attribution, not just an id. Identity events put",
      "session ids in the log; RFC-03 added which harness produced each one,",
      "so a successor is never handed another harness's session. That matters",
      "because cross-harness handoff is supported: a record whose newest",
      "identity came from a different harness is ordinary.",
      "",
      "claude, pi and codex pass. muse fails, below lucid: its identity event",
      "reports an id that is not a key in muse's own store, so hcn refuses the",
      "resume before spawn. lucid then runs the turn fresh and records why",
      "(R002) - a stale hint costs the context, never the turn.",
      "",
      "## Run",
      "",
      "```",
      lines.join("\n"),
      "```",
      "",
      `Verdict: ${ok ? "PASS" : "FAIL"}`,
      "",
    ].join("\n"),
  );
  rmSync(root, { recursive: true, force: true });
  log(`\n=== RESUME ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
};

main().catch((cause) => {
  log(`FATAL: ${String(cause)}`);
  process.exit(1);
});
