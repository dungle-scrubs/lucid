import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCode } from "@dungle-scrubs/harness-cli/src/knowledge/claude-code.js";
import {
  FakeClock,
  FakeProcess,
  fakeSignal,
  fakeSpawner,
} from "@dungle-scrubs/harness-cli/test/execution/fakes.js";
import { openHeadlessSession, openHeadlessTurns } from "../../src/modes/headless.js";
import type { Frame } from "../../src/protocol/index.js";
import {
  createConversationRecord,
  type HostRecord,
  openConversation,
} from "../../src/store/store.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid });
const assistant = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const result = JSON.stringify({ type: "result", subtype: "success" });

/** Full in-process rig: real store host + real openSession over a fake
 * process, wired frame-for-frame with no transport. */
const rig = () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-modes-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const clock = new FakeClock();
  const proc = new FakeProcess();
  const spawner = fakeSpawner([proc]);
  const sig = fakeSignal();
  const records: HostRecord[] = [];

  let receive: (frame: Frame) => void = () => {};
  const host = openConversation(join(root, "conv-1"), {
    now: () => clock.now(),
    presence: () => undefined,
    onRecord: (r) => records.push(r),
    onEffect: (e) => {
      if (e.type === "send") receive(e.frame);
    },
  });

  let turnCount = 0;
  const source = openHeadlessSession({
    harness: claudeCode,
    conversationId: "conv-1",
    secret,
    sessionId: sid,
    runner: { spawn: spawner.spawn, clock, signal: sig.signal },
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame) => host.handleFrame(JSON.stringify(frame)),
  });
  receive = source.receive;

  return { root, secret, clock, proc, host, source, records };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("headless modes (M5.2)", () => {
  test("session mode: attach handshake, one turn mapped event-for-event into the durable log with turnId correlation", async () => {
    const r = rig();

    // The source attached with the minted secret and holds epoch 1.
    expect(r.host.state().epoch).toBe(1);
    expect(r.host.state().attachment?.profile).toBe("headless-session");

    // An input arrives from lucid: session mode delivers it as a send,
    // which starts a turn; the disposition says what HAPPENED.
    r.host.enqueueInput({ id: "in-1", text: "do the thing", mode: "queue" });
    await flush();
    expect(r.proc.stdinLines.some((l) => l.includes("do the thing"))).toBe(true);
    expect(r.host.state().inputs).toEqual([]);
    expect(r.host.state().appliedInputs).toEqual({ "in-1": true });

    // The harness streams; lossless events land as event frames.
    r.proc.emitLine(init);
    r.proc.emitLine(assistant("answer text"));
    r.proc.emitLine(result);
    await flush();
    await flush();

    const eventRecords = r.records.filter(
      (rec) => rec.verdict === "accepted" && "kind" in rec && rec.kind === "event",
    );
    expect(eventRecords.length).toBeGreaterThanOrEqual(3); // identity, message, done
    // Every event frame carries the lucid-minted turnId: correlation from
    // runner events through frames to the durable record.
    for (const rec of eventRecords) {
      if ("turnId" in rec) expect(rec.turnId).toBe("turn-1");
    }

    // The done event is durable in the log (fold sees the whole turn).
    const reopened = openConversation(join(r.root, "conv-1"), {
      now: () => 99_000,
      presence: () => undefined,
      onRecord: () => {},
      onEffect: () => {},
    });
    expect(reopened.state().seq).toBe(r.host.state().seq);
    expect(reopened.state().turn?.turnId).toBe("turn-1");
  });

  test("session mode reports what HAPPENED: steer requested mid-turn, queued delivered", async () => {
    const r = rig();

    // Start a turn, then interject with mode steer while it streams.
    r.host.enqueueInput({ id: "in-1", text: "first", mode: "queue" });
    await flush();
    r.proc.emitLine(init);
    await flush();

    r.host.enqueueInput({ id: "in-2", text: "interject", mode: "steer" });
    await flush();
    // The runner queues mid-turn (A-001): the disposition is queued, not
    // the steer that was requested.
    const inTwo = r.host.state().inputs.find((i) => i.id === "in-2");
    expect(inTwo?.status).toBe("queued");
    const dispositions = r.records.filter(
      (rec) => "kind" in rec && rec.kind === "disposition" && rec.inputId === "in-2",
    );
    expect(dispositions[0]).toMatchObject({ outcome: "queued", inputStatus: "queued" });
  });

  test("turn mode queues between turns: one process per input, dispositions queued -> applied, never interleaved", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-modes-"));
    const { secret } = createConversationRecord(root, "conv-1");
    const clock = new FakeClock();
    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    const spawner = fakeSpawner([proc1, proc2]);
    const sig = fakeSignal();
    const records: HostRecord[] = [];

    let receive: (frame: Frame) => void = () => {};
    const host = openConversation(join(root, "conv-1"), {
      now: () => clock.now(),
      presence: () => undefined,
      onRecord: (rec) => records.push(rec),
      onEffect: (e) => {
        if (e.type === "send") receive(e.frame);
      },
    });
    let turnCount = 0;
    const source = openHeadlessTurns({
      harness: claudeCode,
      conversationId: "conv-1",
      secret,
      runner: { spawn: spawner.spawn, clock, signal: sig.signal },
      mintTurnId: () => `turn-${++turnCount}`,
      sendFrame: (frame) => host.handleFrame(JSON.stringify(frame)),
    });
    receive = source.receive;

    expect(host.state().attachment?.profile).toBe("headless-turn");

    // Two inputs arrive; only ONE process may run at a time.
    host.enqueueInput({ id: "in-1", text: "first prompt", mode: "queue" });
    await flush();
    host.enqueueInput({ id: "in-2", text: "second prompt", mode: "queue" });
    await flush();

    expect(spawner.calls.length).toBe(1);
    expect(spawner.calls[0]?.argv.join(" ")).toContain("first prompt");
    // in-1 went queued then applied (its turn started); in-2 waits queued.
    const forOne = records.filter(
      (rec) => "kind" in rec && rec.kind === "disposition" && rec.inputId === "in-1",
    );
    expect(forOne.map((rec) => ("outcome" in rec ? rec.outcome : ""))).toEqual([
      "queued",
      "applied",
    ]);
    expect(host.state().inputs.find((i) => i.id === "in-2")?.status).toBe("queued");

    // First turn completes: the second spawns with the second prompt.
    proc1.emitLine(init);
    proc1.emitLine(assistant("one done"));
    proc1.emitLine(result);
    proc1.exit(0);
    await flush();
    await flush();
    await flush();

    expect(spawner.calls.length).toBe(2);
    expect(spawner.calls[1]?.argv.join(" ")).toContain("second prompt");
    expect(host.state().appliedInputs).toMatchObject({ "in-1": true, "in-2": true });
  });

  test("droppable events coalesce latest-wins under credit starvation and flush when credit arrives; lossless never waits", async () => {
    const r = rig();
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.proc.emitLine(init);
    await flush();

    // Three token deltas with ZERO credit: none reach the host; they
    // coalesce at the source, latest-wins.
    r.proc.emitLine(
      JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "a" } } }),
    );
    r.proc.emitLine(
      JSON.stringify({
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "ab" } },
      }),
    );
    r.proc.emitLine(
      JSON.stringify({
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "abc" } },
      }),
    );
    await flush();
    await flush();

    const loggedEventKinds = (): string[] =>
      readFileSync(join(r.root, "conv-1", "log.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              src: string;
              frame?: { kind: string; event?: { kind?: string } };
            },
        )
        .filter((e) => e.src === "frame" && e.frame?.kind === "event")
        .map((e) => e.frame?.event?.kind ?? "?");

    // No token reached durability while starved.
    expect(loggedEventKinds().filter((k) => k === "token")).toEqual([]);

    // Lossless still flows while droppables starve.
    r.proc.emitLine(assistant("mid message"));
    await flush();
    expect(loggedEventKinds().at(-1)).toBe("message");

    // Credit arrives: exactly ONE coalesced token frame lands (latest-wins
    // collapsed three deltas into the last one).
    r.host.grantCredit(4);
    await flush();
    expect(loggedEventKinds().filter((k) => k === "token")).toEqual(["token"]);
    const tokenEntry = readFileSync(join(r.root, "conv-1", "log.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { frame?: { event?: { kind?: string; text?: string } } })
      .find((e) => e.frame?.event?.kind === "token");
    expect(tokenEntry?.frame?.event?.text).toBe("abc");

    r.proc.emitLine(result);
    await flush();
  });

  test("limit/error terminates the turn with a durable record: the classified exit survives fold", async () => {
    const r = rig();
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.proc.emitLine(init);
    r.proc.emitStderr("You've hit your weekly limit \u00b7 resets 2am");
    r.proc.exit(1);
    await flush();
    await flush();

    const durableKinds = readFileSync(join(r.root, "conv-1", "log.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            src: string;
            frame?: { event?: { kind?: string; cause?: string } };
          },
      )
      .filter((e) => e.src === "frame" && e.frame?.event !== undefined)
      .map((e) => e.frame?.event);
    // The classified limit AND the terminal done are both durable.
    expect(durableKinds.some((e) => e?.kind === "limit")).toBe(true);
    expect(durableKinds.find((e) => e?.kind === "done")?.cause).toBe("limit");

    // Reopen: fold reproduces the terminated turn exactly.
    const reopened = openConversation(join(r.root, "conv-1"), {
      now: () => 99_000,
      presence: () => undefined,
      onRecord: () => {},
      onEffect: () => {},
    });
    expect(reopened.state().seq).toBe(r.host.state().seq);
    expect(reopened.state().turn?.turnId).toBe("turn-1");
  });
});
