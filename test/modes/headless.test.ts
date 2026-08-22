import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { openHeadlessSession, openHeadlessTurns } from "../../src/modes/headless.js";
import type { Frame } from "../../src/protocol/index.js";
import {
  createConversationRecord,
  type HostRecord,
  openConversation,
} from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const BIN = "/fake/hcn";

// hcn's vocabulary, not a harness's. lucid stopped modelling claude's
// stream-json the day hcn became the only surface it speaks: what these
// tests script is the normalized event stream, so a harness changing its
// own framing cannot reach this file.
const identity = { kind: "identity", sessionId: sid, authority: "caller-assigned" };
const assistant = (text: string) => ({ kind: "message", role: "assistant", text });
const token = (text: string) => ({ kind: "token", text });
const doneClean = { kind: "done", exitCode: null, cause: "clean" };

/** Full in-process rig: real store host + the real hcn adapter over a fake
 * hcn process, wired frame-for-frame with no transport. The late-bound
 * `receive` closes the host->source loop exactly once, for both modes. */
const rig = (opts: { mode?: "session" | "turn"; processes?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "lucid-modes-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const nowMs = 0;
  const procs = Array.from({ length: opts.processes ?? 1 }, () => new FakeHcnProcess());
  const proc = procs[0] as FakeHcnProcess;
  const spawner = fakeSpawner([...procs]);
  const records: HostRecord[] = [];

  let receive: (frame: Frame) => void = () => {};
  const host = openConversation(join(root, "conv-1"), {
    now: () => nowMs,
    presence: () => undefined,
    onRecord: (r) => records.push(r),
    onEffect: (e) => {
      if (e.type === "send") receive(e.frame);
    },
  });

  let turnCount = 0;
  const mode = opts.mode ?? "session";
  const common = {
    harness: "claude" as const,
    conversationId: "conv-1",
    secret,
    runner: createHcnRunner({ spawn: spawner.spawn, bin: BIN }),
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
  };
  const source =
    mode === "session"
      ? openHeadlessSession({ ...common, sessionId: sid })
      : openHeadlessTurns(common);
  receive = source.receive;

  // A session announces itself before it can take a send. Emitting it here
  // is what a live `hcn session --json` does the moment it spawns.
  if (mode === "session") {
    proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
  }

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

  /** hcn answers a send with one disposition, then opens the turn. */
  const accept = (inputId: string, turnId: string, disposition = "started"): void => {
    proc.emit({ kind: "disposition", id: inputId, disposition });
    if (disposition === "started") proc.emit({ kind: "turn", turnId, id: inputId });
  };
  /** The boundary delivery of an input that was queued behind a live turn. */
  const startQueued = (inputId: string, turnId: string): void => {
    proc.emit({ kind: "turn", turnId, id: inputId });
  };

  return {
    root,
    secret,
    proc,
    procs,
    spawner,
    host,
    source,
    records,
    reopen,
    logEntries,
    accept,
    startQueued,
  };
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
    // The command reached hcn's stdin as a send op carrying lucid's id.
    expect(
      r.proc.commands.some((c) => c.op === "send" && c.text === "do the thing" && c.id === "in-1"),
    ).toBe(true);
    r.accept("in-1", "turn-1");
    await flush();
    expect(r.host.state().inputs).toEqual([]);
    expect(r.host.state().appliedInputs).toEqual({ "in-1": true });

    // The harness streams; lossless events land as event frames.
    r.proc.emit(identity);
    r.proc.emit(assistant("answer text"));
    r.proc.emit(doneClean);
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
    const reopened = r.reopen();
    expect(reopened.state().seq).toBe(r.host.state().seq);
    expect(reopened.state().turn?.turnId).toBe("turn-1");
  });

  test("session mode reports what HAPPENED: steer requested mid-turn, queued delivered", async () => {
    const r = rig();

    // Start a turn, then interject with mode steer while it streams.
    r.host.enqueueInput({ id: "in-1", text: "first", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(identity);
    await flush();

    r.host.enqueueInput({ id: "in-2", text: "interject", mode: "steer" });
    await flush();
    // hcn queues mid-turn (A-001): the disposition is queued, not the steer
    // that was requested. lucid reports what happened, not what was asked.
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "queued" });
    await flush();

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
    const proc1 = new FakeHcnProcess();
    const proc2 = new FakeHcnProcess();
    const spawner = fakeSpawner([proc1, proc2]);
    const records: HostRecord[] = [];

    let receive: (frame: Frame) => void = () => {};
    const host = openConversation(join(root, "conv-1"), {
      now: () => 0,
      presence: () => undefined,
      onRecord: (rec) => records.push(rec),
      onEffect: (e) => {
        if (e.type === "send") receive(e.frame);
      },
    });
    let turnCount = 0;
    const source = openHeadlessTurns({
      harness: "claude",
      conversationId: "conv-1",
      secret,
      runner: createHcnRunner({ spawn: spawner.spawn, bin: BIN }),
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
    expect(forOne.length).toBeGreaterThanOrEqual(1);

    proc1.emit(identity);
    proc1.emit(assistant("one done"));
    proc1.emit(doneClean);
    proc1.exit(0);
    await flush();
    await flush();

    // The second process only starts after the first turn ended.
    expect(spawner.calls.length).toBe(2);
    expect(spawner.calls[1]?.argv.join(" ")).toContain("second prompt");
  });

  test("droppable events coalesce latest-wins under credit starvation and flush when credit arrives; lossless never waits", async () => {
    const r = rig();
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(identity);
    await flush();

    // Three token deltas with ZERO credit: none reach the host; they
    // coalesce at the source, latest-wins.
    r.proc.emit(token("a"));
    r.proc.emit(token("ab"));
    r.proc.emit(token("abc"));
    await flush();
    await flush();

    const loggedEventKinds = (): string[] =>
      r
        .logEntries()
        .filter((e) => e.src === "frame" && e.frame?.kind === "event")
        .map((e) => (e.frame?.event?.kind as string | undefined) ?? "?");

    // No token reached durability while starved.
    expect(loggedEventKinds().filter((k) => k === "token")).toEqual([]);

    // Lossless still flows while droppables starve - AND it supersedes
    // the turn's stale deltas: the message carries the whole text, so a
    // coalesced fragment must never land after it.
    r.proc.emit(assistant("mid message"));
    await flush();
    expect(loggedEventKinds().at(-1)).toBe("message");

    r.host.grantCredit(4);
    await flush();
    expect(loggedEventKinds().filter((k) => k === "token")).toEqual([]);

    // With credit in hand, a FRESH delta flows immediately.
    r.proc.emit(token("next"));
    await flush();
    const tokenEntries = r.logEntries().filter((e) => e.frame?.event?.kind === "token");
    // Exactly one token is durable, and it is the fresh one: the three
    // starved deltas coalesced away rather than replaying in order.
    expect(tokenEntries).toHaveLength(1);
    expect(tokenEntries[0]?.frame?.event?.text).toBe("next");

    r.proc.emit(doneClean);
    await flush();
  });

  test("limit/error terminates the turn with a durable record: the classified exit survives fold", async () => {
    const r = rig();
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(identity);
    // hcn classifies the wall and says so; lucid records the classification
    // rather than re-deriving it from a harness's stderr.
    r.proc.emit({ kind: "limit", code: "weekly-limit", message: "weekly limit reached" });
    r.proc.emit({ kind: "done", exitCode: 1, cause: "limit" });
    r.proc.emit({ kind: "closed", exitCode: 1, cause: "limit" });
    r.proc.exit(1);
    await flush();
    await flush();

    const durableKinds = r
      .logEntries()
      .filter((e) => e.src === "frame" && e.frame?.event !== undefined)
      .map((e) => e.frame?.event);
    // The classified limit AND the terminal done are both durable.
    expect(durableKinds.some((e) => e?.kind === "limit")).toBe(true);
    expect(durableKinds.find((e) => e?.kind === "done")?.cause).toBe("limit");

    // Reopen: fold reproduces the terminated turn exactly.
    const reopened = r.reopen();
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
    r.proc.emit(identity);
    // Starved deltas coalesce under turn-1.
    r.proc.emit(token("z"));
    await flush();

    // Credit arrives MID-TURN: the flushed delta lands under turn-1 -
    // never a fabricated id - and the live stream keeps flowing after.
    r.host.grantCredit(2);
    await flush();
    const tokens = r.logEntries().filter((e) => e.frame?.event?.kind === "token");
    expect(tokens.map((e) => e.frame?.turnId)).toEqual(["turn-1"]);

    r.proc.emit(assistant("done text"));
    r.proc.emit(doneClean);
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
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(identity);
    await flush();
    r.host.enqueueInput({ id: "in-2", text: "second", mode: "queue" });
    await flush();
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "queued" });
    await flush();
    expect(r.host.state().inputs.find((i) => i.id === "in-2")?.status).toBe("queued");

    // Turn one ends; hcn delivers the queued send at the boundary and tags
    // the new turn with its id: applied NOW.
    r.proc.emit(doneClean);
    r.startQueued("in-2", "turn-2");
    await flush();
    await flush();
    await flush();
    expect(r.host.state().appliedInputs).toMatchObject({ "in-1": true, "in-2": true });

    // The process dies: the pump releases the channel (detach), so a
    // further input is PARKED - outstanding, armed for the next attach's
    // replay - rather than delivered to a corpse or thrown through the
    // host.
    r.proc.emit(doneClean);
    r.proc.emit({ kind: "closed", exitCode: 0, cause: "clean" });
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

describe("a session hcn refuses is recorded, not silent", () => {
  test("the refusal reason lands in the durable log and the channel is released", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-modes-"));
    const { secret } = createConversationRecord(root, "conv-1");
    const proc = new FakeHcnProcess();
    const spawner = fakeSpawner([proc]);
    let receive: (frame: Frame) => void = () => {};
    const host = openConversation(join(root, "conv-1"), {
      now: () => 0,
      presence: () => undefined,
      onRecord: () => {},
      onEffect: (e) => {
        if (e.type === "send") receive(e.frame);
      },
    });
    const source = openHeadlessSession({
      harness: "codex",
      conversationId: "conv-1",
      secret,
      runner: createHcnRunner({ spawn: spawner.spawn, bin: BIN }),
      mintTurnId: () => "turn-1",
      sendFrame: (frame) => host.handleFrame(JSON.stringify(frame)),
      sessionId: sid,
    });
    receive = source.receive;

    // hcn refuses before spawning: failure, then closed, then exit 2. This is
    // what a harness with no session mode actually produces.
    proc.emit({
      kind: "failure",
      class: "rejected",
      retryable: false,
      issue: "no-session-mode",
      message: "codex declares no persistent headless session mode",
    });
    proc.emit({ kind: "closed", exitCode: null, cause: "failed" });
    proc.exit(2);
    await flush();
    await flush();
    await flush();

    // A refusal ends the source exactly like a clean shutdown, so without
    // this record the log cannot tell one from the other.
    const errors = readFileSync(join(root, "conv-1", "log.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { frame?: { event?: { kind?: string; message?: string } } })
      .filter((e) => e.frame?.event?.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.frame?.event?.message).toContain("session did not open");
    expect(errors[0]?.frame?.event?.message).toContain("no persistent headless session mode");
    // And the channel was released rather than held by a source that is gone.
    expect(host.state().attachment).toBeNull();
  });
});
