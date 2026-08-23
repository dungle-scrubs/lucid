/**
 * Cross-harness handoff: one conversation, two different harnesses.
 *
 * claude establishes a fact and yields. pi takes over the SAME durable record,
 * folds it, and answers a question about that fact. The point is that the
 * conversation belongs to lucid's record, not to whichever process happened to
 * be driving it - which is what the hcn seam made possible, since a harness is
 * now a name.
 *
 * What this deliberately does NOT assume: that pi inherits claude's session
 * memory. It cannot. Each harness holds its own context in its own process, so
 * the successor learns the conversation the only way it can - by reading
 * lucid's transcript and being told it. lucid has no automatic context replay
 * into a new harness today; this script does it explicitly, which is also the
 * honest demonstration that the durable log carries enough to do it.
 *
 * Run: bun scripts/smoke-cross-harness.ts [--from claude] [--to pi]
 * Evidence: spikes/evidence/cross-harness-handoff.md
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../src/harness/hcn-runner.js";
import { nodeHarnessDeps } from "../src/harness/node-deps.js";
import type { HarnessName } from "../src/harness/runner.js";
import { openHeadlessSession, openHeadlessTurns } from "../src/modes/headless.js";
import type { Frame } from "../src/protocol/index.js";
import { createConversationRecord, type HostRecord, openConversation } from "../src/store/store.js";

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};
const FROM = arg("--from", "claude") as HarnessName;
const TO = arg("--to", "pi") as HarnessName;

const CODEWORD = "pomegranate";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lines: string[] = [];
const log = (s: string) => {
  console.log(s);
  lines.push(s);
};

const doneCount = (events: readonly { event: Record<string, unknown> }[]): number =>
  events.filter((e) => e.event.kind === "done").length;

const textOf = (events: readonly { event: Record<string, unknown> }[]): string =>
  events
    .filter((e) => e.event.kind === "message")
    .map((e) => (typeof e.event.text === "string" ? e.event.text : ""))
    .join(" ");

const main = async (): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "lucid-xharness-"));
  const conversationId = "xh-1";
  const dir = join(root, conversationId);
  const { secret } = createConversationRecord(root, conversationId);
  const runner = createHcnRunner(nodeHarnessDeps());
  let ok = true;

  log(`# cross-harness handoff: ${FROM} -> ${TO}`);
  log(`record: ${dir}`);

  /** Open a source on the record for one harness, using whichever profile
   * that harness reports. The record is the same across both. */
  const openFor = async (harness: HarnessName, turnPrefix: string) => {
    const records: HostRecord[] = [];
    let receive: (f: Frame) => void = () => {};
    const host = openConversation(dir, {
      now: () => Date.now(),
      presence: () => undefined,
      onRecord: (r) => records.push(r),
      onEffect: (e) => {
        if (e.type === "send") receive(e.frame);
      },
    });
    let n = 0;
    const common = {
      harness,
      conversationId,
      secret,
      runner,
      mintTurnId: () => `${turnPrefix}-${++n}`,
      sendFrame: (f: Frame) => host.handleFrame(JSON.stringify(f)),
    };
    const hasSession = (await runner.inspect(harness)).session;
    const source = hasSession
      ? openHeadlessSession({ ...common, sessionId: crypto.randomUUID() })
      : openHeadlessTurns(common);
    receive = source.receive;
    return { host, source, records, hasSession };
  };

  /** Wait for `n` MORE completed turns than the record already had. The
   * successor folds the incumbent's turns, so an absolute count is already
   * satisfied before the successor has done anything. */
  const waitForMoreTurns = async (
    host: ReturnType<typeof openConversation>,
    baseline: number,
    n: number,
    ms: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (doneCount(host.transcript().events) >= baseline + n) return true;
      if (host.state().attachment === null) return false;
      await sleep(200);
    }
    return false;
  };

  // --- the incumbent establishes a fact -----------------------------------
  log(`\n## ${FROM} establishes the codeword`);
  const a = await openFor(FROM, "a-turn");
  log(`${FROM} attached: profile ${a.host.state().attachment?.profile}`);
  a.host.enqueueInput({
    id: "in-1",
    text: `Remember this codeword: ${CODEWORD}. Reply with only: ok`,
    mode: "queue",
  });
  if (!(await waitForMoreTurns(a.host, 0, 1, 90_000))) {
    log(`FAIL: ${FROM} did not complete its turn`);
    ok = false;
  }
  const seqAfterFirst = a.host.state().seq;
  log(`${FROM} turn done; seq ${seqAfterFirst}`);

  // --- the incumbent yields -----------------------------------------------
  a.source.close();
  await sleep(1500);
  log(`${FROM} yielded; attachment ${a.host.state().attachment === null ? "released" : "HELD"}`);
  if (a.host.state().attachment !== null) ok = false;

  // --- the successor takes over the SAME record ---------------------------
  log(`\n## ${TO} takes over the same record`);
  const b = await openFor(TO, "b-turn");
  const transcript = b.host.transcript();
  log(`${TO} folded: ${transcript.events.length} events, seq ${b.host.state().seq}`);
  // The fold has to have carried the incumbent's turn across.
  if (b.host.state().seq < seqAfterFirst) {
    log("FAIL: the successor's fold lost the incumbent's turn");
    ok = false;
  }

  // The successor cannot inherit a session it never had. It learns the
  // conversation from lucid's record, which is the whole claim being tested.
  const priorText = textOf(transcript.events);
  const priorInputs = transcript.inputs.map((i) => i.text).join(" | ");
  b.host.enqueueInput({
    id: "in-2",
    text: [
      "Here is the conversation so far, recorded by lucid.",
      `What was said to you: ${priorInputs}`,
      `What was answered: ${priorText}`,
      "",
      "Reply with only the codeword from that conversation.",
    ].join("\n"),
    mode: "queue",
  });
  const baseline = doneCount(transcript.events);
  if (!(await waitForMoreTurns(b.host, baseline, 1, 90_000))) {
    log(`FAIL: ${TO} did not complete its turn`);
    ok = false;
  }

  const afterHandoff = b.host
    .transcript()
    .events.filter((e) => String(e.turnId ?? "").startsWith("b-turn"));
  const answer = textOf(afterHandoff).toLowerCase();
  const recovered = answer.includes(CODEWORD);
  log(`${TO} answered; codeword recovered from the record: ${recovered}`);
  if (!recovered) ok = false;

  // --- the record holds both harnesses' work ------------------------------
  b.source.close();
  await sleep(1500);
  const finalHost = openConversation(dir, {
    now: () => Date.now(),
    presence: () => undefined,
    onRecord: () => {},
    onEffect: () => {},
  });
  const t = finalHost.transcript();
  const turnIds = [...new Set(t.events.map((e) => e.turnId))];
  const fromBoth =
    turnIds.some((i) => i?.startsWith("a-turn")) && turnIds.some((i) => i?.startsWith("b-turn"));
  log(`\n## one record, both harnesses`);
  log(`turnIds: ${turnIds.join(", ")}`);
  log(`events from both sources in one fold: ${fromBoth}`);
  log(`reopened seq ${finalHost.state().seq}, inputs ${t.inputs.length}`);
  if (!fromBoth) ok = false;
  if (t.inputs.length !== 2) {
    log(`FAIL: expected 2 inputs across the handoff, got ${t.inputs.length}`);
    ok = false;
  }

  mkdirSync("spikes/evidence", { recursive: true });
  writeFileSync(
    "spikes/evidence/cross-harness-handoff.md",
    [
      `# Cross-harness handoff - ${FROM} then ${TO}`,
      "",
      "Generated by `bun scripts/smoke-cross-harness.ts`. Rewritten whole on",
      "every run - do not hand-edit.",
      "",
      "## What this proves",
      "",
      "One durable conversation, two different harnesses. The incumbent",
      "establishes a fact and yields; the successor opens the SAME record,",
      "folds it, and answers a question about that fact. The conversation",
      "belongs to lucid's record, not to the process that was driving it.",
      "",
      "The successor does not inherit the incumbent's session - it cannot,",
      "since each harness holds its own context in its own process. It learns",
      "the conversation by being told what lucid recorded. That is the",
      "demonstration: the durable log carries enough to continue on a",
      "different harness. lucid has no automatic context replay into a new",
      "harness yet; this script composes the prompt by hand.",
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
  log(`\n=== CROSS-HARNESS HANDOFF ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
};

main().catch((cause) => {
  log(`FATAL: ${String(cause)}`);
  process.exit(1);
});
