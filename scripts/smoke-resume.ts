/**
 * Resume as its own lane - and it FAILS, on purpose, until lucid persists the
 * harness session id.
 *
 * Establish a fact, lose the process, reopen the record, and ask the harness
 * to recall the fact from its own memory. Both halves of the conversation land
 * in one durable fold, so lucid's record survives. The harness's context does
 * not, and the reason is lucid's:
 *
 *   The harness session id is never written to the record. Turn mode captures
 *   it in memory off the first turn's identity and resumes into it for the
 *   life of ONE source; session mode is handed an id up front. Neither
 *   survives a restart, because nothing persists it. A reopened record cannot
 *   even attempt a resume - it has no id to resume into.
 *
 * A second, separate limit sits below lucid: even given the id,
 * `hcn session --session-id <existing>` re-enters the ID but not the CONTEXT.
 * Verified directly against hcn with lucid out of the way - the second run
 * opens cleanly, reports the same session id on its identity event, and has no
 * memory of the first. Resuming context on claude is `--resume`, which today
 * is the one-shot `run` path, not the session path. That one is an hcn issue.
 *
 * So this lane is a specification of work, not a regression. It stays failing
 * until the id is persisted, and it is deliberately NOT in CI.
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
      "## Status: FAILING, and that is the finding",
      "",
      "A conversation survives losing its process - both halves land in one",
      "durable fold, so lucid's record is intact. The harness's context does",
      "not survive, for two separate reasons in two different places.",
      "",
      "**lucid's:** the harness session id is never written to the record.",
      "Turn mode captures it in memory off the first turn's identity and",
      "resumes into it for the life of one source; session mode is handed an",
      "id up front. Neither survives a restart, so a reopened record has no id",
      "to resume into and cannot even attempt one. Persisting it is the work",
      "this lane specifies.",
      "",
      "**hcn's:** even given the id, `hcn session --session-id <existing>`",
      "re-enters the id but not the context. Verified directly against hcn",
      "with lucid out of the way: the second run opens cleanly, reports the",
      "same session id on its identity event, and remembers nothing. On claude",
      "restoring context is `--resume`, which today is the one-shot `run`",
      "path, not the session path.",
      "",
      "Distinct from cross-harness handoff, which PASSES: there the successor",
      "cannot inherit a session it never had, so it learns the conversation",
      "from lucid's record. Here the session is the same one and the question",
      "is whether lucid can find its way back into it. It cannot, yet.",
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
