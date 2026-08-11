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

/** Full in-process rig: real store host + real runners over fake
 * processes, wired frame-for-frame with no transport. The late-bound
 * `receive` closes the host->source loop exactly once, for both modes. */
const rig = (opts: { mode?: "session" | "turn"; processes?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "lucid-modes-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const clock = new FakeClock();
  const procs = Array.from({ length: opts.processes ?? 1 }, () => new FakeProcess());
  const proc = procs[0] as FakeProcess;
  const spawner = fakeSpawner([...procs]);
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
  const common = {
    harness: claudeCode,
    conversationId: "conv-1",
    secret,
    runner: { spawn: spawner.spawn, clock, signal: sig.signal },
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
  };
  const source =
    (opts.mode ?? "session") === "session"
      ? openHeadlessSession({ ...common, sessionId: sid })
      : openHeadlessTurns(common);
  receive = source.receive;

  const reopen = () =>
    openConversation(join(root, "conv-1"), {
      now: () => 99_000,
      presence: () => undefined,
      onRecord: () => {},
      onEffect: () => {},
    });
  const logEntries = () =>
    readFileSync(join(root, "conv-1", "log.ndjson"), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            src: string;
            frame?: { kind: string; turnId?: string; event?: Record<string, unknown> };
          },
      );

  return { root, secret, clock, proc, procs, spawner, host, source, records, reopen, logEntries };
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

    // Lossless still flows while droppables starve - AND it supersedes
    // the turn's stale deltas: the message carries the whole text, so a
    // coalesced fragment must never land after it.
    r.proc.emitLine(assistant("mid message"));
    await flush();
    expect(loggedEventKinds().at(-1)).toBe("message");

    r.host.grantCredit(4);
    await flush();
    expect(loggedEventKinds().filter((k) => k === "token")).toEqual([]);

    // With credit in hand, a FRESH delta flows immediately.
    r.proc.emitLine(
      JSON.stringify({
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "next" } },
      }),
    );
    await flush();
    const tokenEntry = readFileSync(join(r.root, "conv-1", "log.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { frame?: { event?: { kind?: string; text?: string } } })
      .find((e) => e.frame?.event?.kind === "token");
    expect(tokenEntry?.frame?.event?.text).toBe("next");

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
    // The dead session released the channel: the pump's completion sent
    // detach(shutdown), which aborts the dangling turn - no writer, no
    // phantom in-flight turn.
    expect(reopened.state().turn).toBeNull();
    expect(reopened.state().attachment).toBeNull();
  });

  test("turn-mode credit flush keeps each delta under its OWN turn - no fabricated turnId, no wedge, and the stream survives", async () => {
    const r = rig({ mode: "turn", processes: 2 });

    r.host.enqueueInput({ id: "in-1", text: "first", mode: "queue" });
    await flush();
    r.proc.emitLine(init);
    // Starved deltas coalesce under turn-1.
    r.proc.emitLine(
      JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "z" } } }),
    );
    await flush();

    // Credit arrives MID-TURN: the flushed delta lands under turn-1 -
    // never a fabricated id - and the live stream keeps flowing after.
    r.host.grantCredit(2);
    await flush();
    const tokens = r.logEntries().filter((e) => e.frame?.event?.kind === "token");
    expect(tokens.map((e) => e.frame?.turnId)).toEqual(["turn-1"]);

    r.proc.emitLine(assistant("done text"));
    r.proc.emitLine(result);
    r.proc.exit(0);
    await flush();
    await flush();
    // No turn-id-reused / gap-n wedge: the message and done were accepted.
    const kinds = r.logEntries().map((e) => e.frame?.event?.kind);
    expect(kinds).toContain("message");
    expect(kinds).toContain("done");
    expect(r.host.state().turn?.turnId).toBe("turn-1");
  });

  test("session mode: a queued input flips to applied when its turn starts, and a dead session answers rejected - never a throw", async () => {
    const r = rig();

    // First input starts a turn; second queues mid-turn.
    r.host.enqueueInput({ id: "in-1", text: "first", mode: "queue" });
    await flush();
    r.proc.emitLine(init);
    await flush();
    r.host.enqueueInput({ id: "in-2", text: "second", mode: "queue" });
    await flush();
    expect(r.host.state().inputs.find((i) => i.id === "in-2")?.status).toBe("queued");

    // Turn one ends; the runner starts the queued send: applied NOW.
    r.proc.emitLine(result);
    await flush();
    await flush();
    await flush();
    expect(r.host.state().appliedInputs).toMatchObject({ "in-1": true, "in-2": true });

    // The process dies: the pump releases the channel (detach), so a
    // further input is PARKED - outstanding, armed for the next attach's
    // replay - rather than delivered to a corpse or thrown through the
    // host. (session.send throwing inside the pre-detach window answers
    // `rejected`; the reducer returns it to the queue either way.)
    r.proc.emitLine(result);
    r.proc.exit(0);
    await flush();
    await flush();
    expect(r.host.state().attachment).toBeNull();
    r.host.enqueueInput({ id: "in-3", text: "too late", mode: "queue" });
    await flush();
    const inThree = r.host.state().inputs.find((i) => i.id === "in-3");
    expect(inThree?.status).toBe("outstanding");
    // Nothing was sent anywhere: no attachment, no delivery.
    expect(r.records.filter((rec) => "inputId" in rec && rec.inputId === "in-3").length).toBe(1); // the enqueue record only - no disposition ever followed
  });
});
