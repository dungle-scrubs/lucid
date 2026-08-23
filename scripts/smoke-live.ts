/**
 * M7.2 DF-SMOKE - the live conversation smoke. Drives a REAL claude
 * through the full lucid substrate: the durable store hosts the reducer,
 * a headless-session source drives a real `hcn session --json`, which
 * drives claude, and every event folds back into the store's transcript.
 * This is the on-demand, evidence-logged run the plan defers from CI - it
 * needs an installed claude and is nondeterministic. Evidence is written
 * to spikes/evidence/df-smoke.md.
 *
 * Run: bun scripts/smoke-live.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../src/harness/hcn-runner.js";
import { nodeHarnessDeps } from "../src/harness/node-deps.js";
import { openHeadlessSession, openHeadlessTurns } from "../src/modes/headless.js";
import type { Frame } from "../src/protocol/index.js";
import { createConversationRecord, type HostRecord, openConversation } from "../src/store/store.js";

/** Which harness to drive. The seam made this a name, so the smoke takes it
 * as one: `bun scripts/smoke-live.ts --harness pi`. */
const HARNESS = ((): "claude" | "codex" | "pi" | "muse" => {
  const i = process.argv.indexOf("--harness");
  const v = i === -1 ? "claude" : (process.argv[i + 1] ?? "claude");
  if (v !== "claude" && v !== "codex" && v !== "pi" && v !== "muse") {
    throw new Error(`unknown harness ${v}`);
  }
  return v;
})();

/** Optional routing, for the local-provider lane: pi against LM Studio. */
const flagValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const PROVIDER = flagValue("--provider");
const MODEL = flagValue("--model");
/** Per-turn budget. A local model on LM Studio is far slower than a hosted
 * one, so the lane that routes there raises it rather than reading a slow
 * model as a failure. */
const TURN_BUDGET_MS = Number(flagValue("--turn-budget") ?? "90000");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The runner's boundary log, read back for the evidence header so the file
 * names the binary and version that actually ran. */
const hcnLog: Record<string, unknown>[] = [];
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

/** Wait until the transcript shows `n` completed turns, or time out. */
const waitForTurns = async (
  host: ReturnType<typeof openConversation>,
  n: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (doneCount(host.transcript().events) >= n) return true;
    // A source that died has nothing left to wait for. Polling the full
    // budget after a refusal turns a two-second answer into a 90-second one,
    // which is how a codex run (no session mode) used to read.
    if (host.state().attachment === null) return false;
    await sleep(200);
  }
  return false;
};

const main = async (): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "lucid-df-smoke-"));
  const conversationId = "smoke-1";
  const sessionId = crypto.randomUUID();
  const { secret } = createConversationRecord(root, conversationId);
  log(`# DF-SMOKE live conversation - ${HARNESS}, sessionId ${sessionId}`);
  log(`record: ${join(root, conversationId)}`);

  const records: HostRecord[] = [];
  let receive: (frame: Frame) => void = () => {};
  const host = openConversation(join(root, conversationId), {
    now: () => Date.now(), // live wall-clock (determinism was for tests)
    presence: () => undefined,
    onRecord: (r) => records.push(r),
    onEffect: (e) => {
      if (e.type === "send") receive(e.frame);
    },
  });

  let turnCount = 0;
  const runner = createHcnRunner(nodeHarnessDeps((e) => hcnLog.push(e)));
  // The profile is the harness's answer, not a constant: claude and pi hold a
  // session, codex and muse do not and get one process per turn. Asking hcn
  // is the same runtime-verified check `lucid run` makes.
  const hasSession = (await runner.inspect(HARNESS)).session;
  const common = {
    harness: HARNESS,
    conversationId,
    secret,
    runner,
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
  };
  const source = hasSession
    ? openHeadlessSession({
        ...common,
        sessionId,
        ...(PROVIDER === undefined ? {} : { provider: PROVIDER }),
        ...(MODEL === undefined ? {} : { model: MODEL }),
      })
    : openHeadlessTurns(common);
  receive = source.receive;
  log(`attached: epoch ${host.state().epoch}, profile ${host.state().attachment?.profile}`);

  // Grant droppable credit so token deltas flow (lossless flows regardless).
  host.grantCredit(1000);

  let ok = true;

  // Turn 1: establish a codeword.
  log("\n## turn 1: establish codeword");
  host.enqueueInput({
    id: "in-1",
    text: "Remember the codeword: pomegranate. Reply with only: OK",
    mode: "queue",
  });
  if (!(await waitForTurns(host, 1, TURN_BUDGET_MS))) {
    log("FAIL: turn 1 did not complete in 90s");
    ok = false;
  } else {
    log(`turn 1 done; seq now ${host.state().seq}`);
  }

  // Turn 2: continuity - the session must remember the codeword.
  log(hasSession ? "\n## turn 2: session continuity" : "\n## turn 2: second turn (new process)");
  host.enqueueInput({
    id: "in-2",
    text: "Reply with only the codeword I gave you.",
    mode: "queue",
  });
  const twoDone = await waitForTurns(host, 2, TURN_BUDGET_MS);
  const t = host.transcript();
  const answer = textOf(t.events.filter((e) => e.turnId === "turn-2"));
  const remembered = answer.toLowerCase().includes("pomegranate");
  log(`turn 2 done=${twoDone}; answer="${answer.slice(0, 80)}"; remembered=${remembered}`);
  if (!twoDone) ok = false;
  // Only a session claims in-process memory. Turn mode gets a new process per
  // turn, so continuity there would be a resume - a different lane, not this
  // one. Asserting it here would be asserting something the mode never
  // promised.
  if (hasSession && !remembered) ok = false;

  // Transcript shape: one identity, ordered strictly-increasing seqs.
  const identities = t.events.filter((e) => e.event.kind === "identity").length;
  const seqs = t.events.map((e) => e.seq);
  const ordered = seqs.every((s, i) => i === 0 || s > (seqs[i - 1] ?? -1));
  log(
    `\n## transcript: ${t.events.length} events, identities=${identities}, ordered=${ordered}, epochs=${[...new Set(t.events.map((e) => e.epoch))].join(",")}`,
  );
  // One identity per PROCESS. A session is one process for the whole
  // conversation, so exactly one; turn mode spawns per turn, so one each.
  // Requiring 1 of both modes would fail turn mode for behaving correctly.
  const expectedIdentities = hasSession ? 1 : 2;
  if (identities !== expectedIdentities || !ordered) ok = false;

  // Kill + resume: close (which appends a detach, advancing the log),
  // then reopen and assert the fold equals the live transcript AT THE SAME
  // log position - so capture the live transcript AFTER close, not before.
  log("\n## kill + resume: reopen the durable log");
  source.close();
  const tFinal = host.transcript();
  const reopened = openConversation(join(root, conversationId), {
    now: () => Date.now(),
    presence: () => undefined,
    onRecord: () => {},
    onEffect: () => {},
  });
  const foldMatches = JSON.stringify(reopened.transcript()) === JSON.stringify(tFinal);
  log(
    `pre-close events=${t.events.length}; post-close seq=${host.state().seq}; reopened seq=${reopened.state().seq}; fold matches live=${foldMatches}`,
  );
  if (!foldMatches) ok = false;

  // Evidence.
  const resolved = hcnLog.find((e) => e.event === "hcn_resolved");
  const hcnVersion =
    resolved === undefined
      ? "unknown"
      : `${String(resolved.version)} (${String(resolved.bin)}, via ${String(resolved.source)})`;
  mkdirSync("spikes/evidence", { recursive: true });
  // The file is rewritten whole on every run, so anything a reader needs has
  // to be generated here. Prose appended by hand does not survive.
  writeFileSync(
    `spikes/evidence/df-smoke${HARNESS === "claude" ? "" : `-${HARNESS}`}.md`,
    [
      `# DF-SMOKE - live conversation against ${HARNESS} ${sessionId}`,
      "",
      "Generated by `bun scripts/smoke-live.ts`. Rewritten in full on every",
      "run - do not hand-edit, the next run will discard it.",
      "",
      "## What this proves that the deterministic suite cannot",
      "",
      "lucid drives the harness by spawning `hcn --json` and reading NDJSON;",
      "the test suite drives a fake hcn. This run is the real one: a real",
      "`hcn session --json` process, holding a real claude session across two",
      "turns. It proves the codeword survives WITHIN the session rather than",
      "through a resume, that every event folds into the durable log under its",
      "lucid-minted turnId, and that the reopened fold matches the live",
      "transcript after the process dies.",
      "",
      `hcn: ${hcnVersion}`,
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

  log(`\n=== DF-SMOKE ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
};

main().catch((cause) => {
  log(`FATAL: ${String(cause)}`);
  process.exit(1);
});
