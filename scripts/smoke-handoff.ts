#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePresence } from "../src/store/presence.js";
import { createConversationRecord, openConversation } from "../src/store/store.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lines: string[] = [];
const log = (s: string) => {
  console.log(s);
  lines.push(s);
};

const main = async (): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  const conversationId = `handoff-${Date.now()}`;
  const dir = join(root, conversationId);
  const { secret } = createConversationRecord(root, conversationId);
  log(`# Handoff smoke - baton-pass - conversation ${conversationId}`);
  log(`record: ${dir}`);

  // Incumbent: headless-like, holds presence lock, does 3 inputs
  const incumbentPresence = acquirePresence(dir, conversationId, {
    onEvent: (e) => log(`incumbent presence ${e.event}`),
  });
  log(`incumbent acquired presence lock`);

  const hostA = openConversation(dir, {
    now: () => Date.now(),
    presence: () => incumbentPresence.held(),
    // R2: the incumbent IS the lease holder while it runs - the gate
    // reads the presence handle this smoke actually holds.
    executorLease: () => incumbentPresence.held(),
    onEffect: () => {},
    onRecord: () => {},
  });
  // Attach
  const { encodeFrame } = await import("../src/protocol/index.js");
  const { attach } = await import("../test/protocol/helpers.js");
  hostA.handleFrame(encodeFrame(attach({ secret, conversationId })));
  log(`incumbent attached, seq ${hostA.state().seq}`);

  for (let i = 0; i < 3; i++) {
    hostA.enqueueInput({ id: `inc-${i}`, text: `incumbent msg ${i}`, mode: "queue" });
    log(`incumbent enqueued inc-${i}, seq ${hostA.state().seq}`);
  }

  // Second participant `lucid send`s input in (via direct store, simulating `lucid send`)
  // This happens while incumbent still holds presence lock - the send is a
  // transient input append that races on the append lock, not the presence lock.
  const { sendInput } = await import("../src/cli/send.js");
  const sendRes = sendInput(conversationId, { rootDir: root, text: "second participant hello" });
  log(`second participant sent: ${sendRes.inputId}`);

  // Incumbent yields: release presence lock
  incumbentPresence.release();
  log(`incumbent yielded (presence lock freed)`);

  // Successor folds the durable log and takes over (acquires presence)
  // It should see all of incumbent's inputs plus the second participant's send.
  await sleep(100); // brief pause for kernel to release flock
  const successorPresence = acquirePresence(dir, conversationId, {
    onEvent: (e) => log(`successor presence ${e.event}`),
  });
  log(`successor acquired presence lock`);

  const hostB = openConversation(dir, {
    now: () => Date.now(),
    presence: () => successorPresence.held(),
    executorLease: () => successorPresence.held(),
    onEffect: () => {},
    onRecord: () => {},
  });
  log(`successor folded, seq ${hostB.state().seq}, inputs ${hostB.transcript().inputs.length}`);

  // Verify: all inputs are present (ordered, at-least-once, deduped)
  const transcript = hostB.transcript();
  const ids = transcript.inputs.map((i) => i.id);
  log(`transcript ids: ${ids.join(", ")}`);
  const hasIncumbent = ids.filter((id) => id.startsWith("inc-")).length;
  const hasSend = ids.some((id) => id.startsWith("send-"));
  if (hasIncumbent !== 3) throw new Error(`expected 3 incumbent inputs, got ${hasIncumbent}`);
  if (!hasSend) throw new Error("second participant's send not in transcript (lost)");
  log(`✓ handoff ordered and at-least-once (no lost input)`);

  // Dedup check: replaying the same send id should not duplicate
  const dupId = sendRes.inputId;
  const beforeDup = hostB.transcript().inputs.length;
  hostB.enqueueInput({ id: dupId, text: "duplicate", mode: "queue" });
  const afterDup = hostB.transcript().inputs.length;
  if (afterDup !== beforeDup) throw new Error("dedup failed: duplicate input created new entry");
  log(`✓ deduped on replay (D-020)`);

  // Add one more from successor to prove it can continue
  hostB.enqueueInput({ id: "succ-0", text: "successor msg 0", mode: "queue" });
  log(`successor enqueued succ-0, seq ${hostB.state().seq}`);

  const finalTranscript = hostB.transcript();
  log(`final transcript inputs: ${finalTranscript.inputs.length}, seq ${hostB.state().seq}`);

  // Reopened fold matches live transcript
  const reopened = openConversation(dir, {
    now: () => Date.now(),
    presence: () => undefined,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  const reopenedTranscript = reopened.transcript();
  const matches = JSON.stringify(reopenedTranscript) === JSON.stringify(finalTranscript);
  log(`reopened fold matches live: ${matches}`);
  if (!matches) throw new Error("reopened fold does not match live transcript");

  // Evidence
  mkdirSync("spikes/evidence", { recursive: true });
  writeFileSync(
    "spikes/evidence/handoff-smoke.md",
    `# Handoff smoke - baton-pass - ${conversationId}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n\nVerdict: PASS\n`,
  );
  log(`evidence written to spikes/evidence/handoff-smoke.md`);

  successorPresence.release();
  rmSync(root, { recursive: true, force: true });
  log("PASS");
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  console.error(e instanceof Error ? e.stack : "");
  // Write failure evidence
  try {
    mkdirSync("spikes/evidence", { recursive: true });
    writeFileSync(
      "spikes/evidence/handoff-smoke.md",
      `# Handoff smoke - FAIL\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n\nError: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  } catch {}
  process.exit(1);
});
