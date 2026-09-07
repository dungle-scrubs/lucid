/**
 * RFC-12 stage 2: the driver honors the preference.
 *
 * Full in-process rigs (real store host + the real hcn adapter over fake
 * hcn processes, the same shape as headless.test.ts) driving the honoring
 * driver: a preference changed in the record re-spawns the harness before
 * the next turn, no input is lost, the conversation continues, and a
 * refused re-spawn preserves the pending prompt and selected settings (RFC 15).
 *
 * The scripted events are hcn's vocabulary, not a harness's (the same
 * rule headless.test.ts states). The session-refusal fixture is a
 * recording; the turn-mode refusal events are composed inline from the
 * exit-2 shape the pinned binary emits (failure class `rejected`, then
 * done cause `failed`) because no recording of a refused `hcn run`
 * exists yet.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { HarnessName } from "../../src/harness/runner.js";
import { HCN_MIN_VERSION } from "../../src/harness/version.js";
import { type HonoringSource, openHonoringDriver } from "../../src/modes/honor.js";
import { createHeadlessHost } from "../../src/modes/host.js";
import type { Frame } from "../../src/protocol/index.js";
import {
  type DriverChoice,
  readDriverPreference,
  writeDriverPreference,
} from "../../src/store/driver-preference.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { FakeHcnProcess, fakeArtifactHost, fakeSpawner, fixtureEvents } from "../harness/fakes.js";

const SID = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const BIN = "/fake/hcn";

// hcn's own descriptor facts, read once here as a table: claude and pi
// declare a sessionMode, codex and muse do not. A table (not a scripted
// `hcn inspect` process) keeps every fake process accounted to a spawn.
const SESSION_CAPABLE: Record<HarnessName, boolean> = {
  claude: true,
  pi: true,
  codex: false,
  muse: false,
};

// hcn's vocabulary, not a harness's.
const identity = (sessionId: string) => ({
  kind: "identity",
  sessionId,
  authority: "caller-assigned",
});
const assistant = (text: string) => ({ kind: "message", role: "assistant", text });
const doneClean = { kind: "done", exitCode: null, cause: "clean" };

/** Let the promise chains run: every step in these rigs is event-driven
 * (an emitted line, a resolved handshake), so a handful of macrotask
 * ticks is a complete, deterministic settle. */
const settle = async (ticks = 12): Promise<void> => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Wait until a condition holds, failing loudly rather than hanging. */
const until = async (cond: () => boolean, what: string, ticks = 200): Promise<void> => {
  for (let i = 0; i < ticks && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};

interface Rig {
  readonly driver: HonoringSource;
  readonly procs: FakeHcnProcess[];
  readonly spawner: ReturnType<typeof fakeSpawner>;
  readonly host: ReturnType<typeof openConversation>;
  readonly dir: string;
  readonly writePref: (choice: DriverChoice) => void;
  readonly pref: () => ReturnType<typeof readDriverPreference>;
  readonly send: (id: string, text?: string) => void;
  readonly logText: () => string;
  readonly frames: () => Frame[];
  readonly appliedCount: (id: string) => number;
  readonly argvOf: (i: number) => readonly string[];
  readonly closeSession: (proc: FakeHcnProcess) => Promise<void>;
}

/** Build a full in-process rig around the honoring driver. */
const openRig = async (
  opts: { readonly harness?: HarnessName; readonly pinned?: boolean } = {},
): Promise<Rig> => {
  const root = mkdtempSync(join(tmpdir(), "lucid-honor-"));
  const dir = join(root, "conv-1");
  const { secret } = createConversationRecord(root, "conv-1");
  const nowMs = 0;
  const procs = Array.from({ length: 4 }, () => new FakeHcnProcess());
  const spawner = fakeSpawner([...procs]);

  let receive: (frame: Frame) => void = () => {};
  const host = openConversation(dir, {
    now: () => nowMs,
    presence: () => undefined,
    // The rig stands in for the lease-holding runtime, so it acts on the
    // effects it produces (RFC-04 R2).
    executorLease: () => true,
    onRecord: () => {},
    onEffect: (e) => {
      if (e.type === "send") receive(e.frame);
    },
  });

  let turnCount = 0;
  let sessionCount = 0;
  const driver = await openHonoringDriver({
    base: {
      conversationId: "conv-1",
      secret,
      runner: createHcnRunner({ spawn: spawner.spawn, bin: BIN }),
      host: fakeArtifactHost(),
      mintTurnId: () => `turn-${++turnCount}`,
      sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
    },
    sessionCapable: (h) => Promise.resolve(SESSION_CAPABLE[h]),
    initialHarness: opts.harness ?? "claude",
    harnessPinned: opts.pinned ?? false,
    readPreference: () => readDriverPreference(dir),
    mintSessionId: () => `sess-${++sessionCount}`,
    createHostFn: createHeadlessHost,
  });
  receive = driver.receive;

  const rig: Rig = {
    driver,
    procs,
    spawner,
    host,
    dir,
    writePref: (choice) => writeDriverPreference(dir, choice),
    pref: () => readDriverPreference(dir),
    send: (id, text = `text-${id}`) => {
      const result = host.enqueueInput({ id, text, mode: "queue" });
      if (result.verdict === "refused") throw new Error(`input refused: ${result.issue}`);
    },
    logText: () => readFileSync(join(dir, "log.ndjson"), "utf8"),
    frames: () =>
      rig
        .logText()
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => {
          // Log entries wrap frames (src: "frame") and inputs (src:
          // "input"); the assertions here read the frames.
          const entry = JSON.parse(l) as { frame?: unknown };
          return (entry.frame ?? entry) as Frame;
        }),
    appliedCount: (id) =>
      rig
        .frames()
        .filter(
          (f) =>
            "inputId" in f &&
            (f as { inputId?: string }).inputId === id &&
            "outcome" in f &&
            (f as { outcome?: string }).outcome === "applied",
        ).length,
    argvOf: (i) => spawner.calls[i]?.argv ?? [],
    /** Answer the session close a driver change writes, so the old
     * source's pump can end: hcn's own close handshake. */
    closeSession: async (proc) => {
      await until(() => proc.commands.some((c) => c.op === "close"), "close command");
      proc.emit({ kind: "closed", exitCode: 0, cause: "closed" });
      proc.exit(0);
      await settle();
    },
  };
  return rig;
};

/** The session handshake a live `hcn session --json` does on spawn. */
const sessionLine = (proc: FakeHcnProcess, sessionId: string): void => {
  proc.emit({
    kind: "session",
    sessionId,
    harness: "claude",
    hcn: HCN_MIN_VERSION,
    escalateQuestions: true,
  });
};

/** hcn answers a send with one disposition, then opens the turn. */
const accept = (proc: FakeHcnProcess, inputId: string, turnId: string): void => {
  proc.emit({ kind: "disposition", id: inputId, disposition: "started" });
  proc.emit({ kind: "turn", turnId, id: inputId });
};

describe("RFC-12: the driver honors a changed preference (session profile)", () => {
  test("a changed model re-spawns the session before the next turn, and the argv carries it", async () => {
    const r = await openRig();
    const proc1 = r.procs[0] as FakeHcnProcess;
    sessionLine(proc1, SID);

    // First turn on the initial spawn, so the record holds a session to
    // recall: the identity event is what attributes it (RFC-03).
    r.send("A");
    await until(() => proc1.commands.some((c) => c.op === "send"), "first send");
    accept(proc1, "A", "hcn-t1");
    proc1.emit(identity(SID));
    proc1.emit(assistant("first answer"));
    proc1.emit(doneClean);
    await settle();
    expect(r.appliedCount("A")).toBe(1);

    // The person chooses a model in the browser.
    r.writePref({ harness: "claude", model: "claude-opus-5" });
    expect(r.pref()?.model).toBe("claude-opus-5");

    // The next input must NOT reach the old session: the boundary hands it
    // to a new spawn under the chosen flags.
    r.send("B");
    await r.closeSession(proc1);

    const proc2 = r.procs[1] as FakeHcnProcess;
    expect(r.argvOf(1)).toEqual([
      BIN,
      "session",
      "claude",
      "--json",
      "--resume",
      SID,
      "--model",
      "claude-opus-5",
    ]);
    sessionLine(proc2, SID);
    await until(
      () => proc2.commands.some((c) => c.op === "send" && c.id === "B"),
      "replayed send on the new spawn",
    );
    accept(proc2, "B", "hcn-t2");
    proc2.emit(assistant("second answer"));
    proc2.emit(doneClean);
    await settle();

    // The conversation continued: B ran exactly once, on the new spawn.
    expect(r.appliedCount("B")).toBe(1);
    expect(r.logText()).toContain("second answer");
    // The switch is a fresh attach, not a restart of the process: two
    // attaches, the second one after the detach the old source wrote.
    const attaches = r.frames().filter((f) => f.kind === "attach");
    expect(attaches.length).toBe(2);
    expect(r.driver.state()).toEqual({
      spawn: { harness: "claude", model: "claude-opus-5" },
      profile: "headless-session",
      ended: false,
    });
  });

  test("an input queued mid-turn is not lost to the switch: it runs on the new spawn", async () => {
    const r = await openRig();
    const proc1 = r.procs[0] as FakeHcnProcess;
    sessionLine(proc1, SID);

    r.send("A");
    await until(() => proc1.commands.some((c) => c.op === "send" && c.id === "A"), "send A");
    accept(proc1, "A", "hcn-t1");
    // Let the pump take the turn: A is now running, and the next input
    // waits for its boundary.
    await settle();
    // The person chooses while A is mid-turn, then sends: B must queue,
    // and the choice must take effect at A's boundary - not interrupt it.
    r.writePref({ harness: "claude", model: "claude-opus-5" });
    r.send("B");
    proc1.emit(identity(SID));
    proc1.emit(doneClean);
    // The boundary fires on the done: the waiting input must NOT be handed
    // to the old session - the source ends for the driver change instead.
    await r.closeSession(proc1);

    const proc2 = r.procs[1] as FakeHcnProcess;
    sessionLine(proc2, SID);
    await until(() => proc2.commands.some((c) => c.op === "send" && c.id === "B"), "B replayed");
    accept(proc2, "B", "hcn-t2");
    proc2.emit(assistant("B answered"));
    proc2.emit(doneClean);
    await settle();

    expect(r.appliedCount("B")).toBe(1);
    expect(r.logText()).toContain("B answered");
    expect(r.argvOf(1)).toContain("--model");
    expect(r.argvOf(1)).toContain("claude-opus-5");
  });

  test("a new harness is named on the attach and the old session id is not carried across", async () => {
    const r = await openRig();
    const proc1 = r.procs[0] as FakeHcnProcess;
    sessionLine(proc1, SID);
    r.send("A");
    await until(() => proc1.commands.some((c) => c.op === "send" && c.id === "A"), "send A");
    accept(proc1, "A", "hcn-t1");
    proc1.emit(identity(SID));
    proc1.emit(doneClean);
    await settle();

    // Choose a different harness, with a provider pi can express.
    r.writePref({ harness: "pi", model: "zai/glm-5.2", provider: "lmstudio" });
    r.send("B");
    await r.closeSession(proc1);

    const proc2 = r.procs[1] as FakeHcnProcess;
    const argv = r.argvOf(1);
    expect(argv.slice(0, 4)).toEqual([BIN, "session", "pi", "--json"]);
    // The record holds no pi session: a fresh session-id, never claude's.
    expect(argv).toContain("--session-id");
    expect(argv.join(" ")).not.toContain(SID);
    expect(argv).toEqual(
      expect.arrayContaining(["--model", "zai/glm-5.2", "--provider", "lmstudio"]),
    );

    sessionLine(proc2, "pi-fresh");
    await until(() => proc2.commands.some((c) => c.op === "send" && c.id === "B"), "B on pi");
    accept(proc2, "B", "hcn-t2");
    proc2.emit(assistant("pi answered"));
    proc2.emit(doneClean);
    await settle();

    expect(r.appliedCount("B")).toBe(1);
    // The attach names the harness that now drives.
    const attachFrames = r.frames().filter((f) => f.kind === "attach");
    expect(attachFrames.map((f) => (f as { harness?: string }).harness)).toEqual(["claude", "pi"]);
  });

  test("a changed effort re-spawns the session before the next turn, and the argv carries it", async () => {
    const r = await openRig();
    const proc1 = r.procs[0] as FakeHcnProcess;
    sessionLine(proc1, SID);
    r.send("A");
    await until(() => proc1.commands.some((c) => c.op === "send" && c.id === "A"), "send A");
    accept(proc1, "A", "hcn-t1");
    proc1.emit(identity(SID));
    proc1.emit(assistant("first answer"));
    proc1.emit(doneClean);
    await settle();
    expect(r.appliedCount("A")).toBe(1);

    // `hcn session` has carried --effort since 0.6.0: a session driver
    // switches on the dimension exactly like a turn driver.
    r.writePref({ harness: "claude", effort: "high" });
    r.send("B");
    await r.closeSession(proc1);

    const proc2 = r.procs[1] as FakeHcnProcess;
    expect(r.argvOf(1)).toEqual([
      BIN,
      "session",
      "claude",
      "--json",
      "--resume",
      SID,
      "--effort",
      "high",
    ]);
    sessionLine(proc2, SID);
    await until(
      () => proc2.commands.some((c) => c.op === "send" && c.id === "B"),
      "replayed send on the new spawn",
    );
    accept(proc2, "B", "hcn-t2");
    proc2.emit(assistant("second answer"));
    proc2.emit(doneClean);
    await settle();

    expect(r.spawner.calls.length).toBe(2);
    expect(r.appliedCount("B")).toBe(1);
    expect(r.logText()).toContain("second answer");
    expect(r.driver.state()).toEqual({
      spawn: { harness: "claude", effort: "high" },
      profile: "headless-session",
      ended: false,
    });
  });
});

describe("RFC 15: a refused change preserves the selection and prompt", () => {
  test("a refused session spawn stops without returning to the previous driver", async () => {
    const r = await openRig();
    const proc1 = r.procs[0] as FakeHcnProcess;
    sessionLine(proc1, SID);
    r.send("A");
    await until(() => proc1.commands.some((c) => c.op === "send" && c.id === "A"), "send A");
    accept(proc1, "A", "hcn-t1");
    proc1.emit(identity(SID));
    proc1.emit(doneClean);
    await settle();

    r.writePref({ harness: "pi", model: "bogus-model" });
    r.send("B");
    await r.closeSession(proc1);

    // The refused spawn: the recording of a real hcn session refusal.
    const proc2 = r.procs[1] as FakeHcnProcess;
    await until(() => r.spawner.calls.length >= 2, "the switch spawn");
    for (const e of fixtureEvents("session-refusal-no-session-mode")) proc2.emit(e);
    proc2.exit(2);

    await settle();
    expect(r.driver.state().ended).toBe(true);
    expect(r.spawner.calls).toHaveLength(2);
    expect(r.appliedCount("B")).toBe(0);
    expect(r.host.state().inputs.some((input) => input.id === "B")).toBe(true);
    expect(r.pref()).toMatchObject({ harness: "pi", model: "bogus-model" });
    expect(r.logText()).toContain("no persistent headless session mode");
    r.send("C");
    await settle();
    expect(r.spawner.calls).toHaveLength(2);
    expect(r.appliedCount("C")).toBe(0);
  });

  test("a refused turn spawn keeps the input pending and the requested model selected", async () => {
    const r = await openRig({ harness: "codex" });
    const proc1 = r.procs[0] as FakeHcnProcess;

    // Turn profile: one process per turn. First turn lands a session id.
    r.send("A");
    await until(() => r.spawner.calls.length >= 1, "the first turn spawn");
    proc1.emit(identity("codex-sess-1"));
    proc1.emit(assistant("turn one"));
    proc1.emit(doneClean);
    proc1.exit(0);
    await settle();
    expect(r.appliedCount("A")).toBe(1);

    r.writePref({ harness: "codex", model: "totally-bogus" });
    r.send("B");
    // The switch spawns the refused invocation (same harness, so its
    // session is recalled with --resume).
    const proc2 = r.procs[1] as FakeHcnProcess;
    await until(() => r.spawner.calls.length >= 2, "the switch spawn");
    const switchArgv = r.argvOf(1);
    expect(switchArgv).toEqual(
      expect.arrayContaining(["--model", "totally-bogus", "--resume", "codex-sess-1"]),
    );

    // The exit-2 refusal shape the pinned hcn emits for `hcn run` with an
    // unknown model: failure class rejected, then done. Composed inline
    // (no recording exists); the probe reads exactly the first event.
    proc2.emit({
      kind: "failure",
      class: "rejected",
      retryable: false,
      message: 'Request rejected (unknown codex model "totally-bogus") - change options or harness',
      issue: "unknown-model",
      supported: ["gpt-6"],
    });
    proc2.emit({
      kind: "done",
      exitCode: null,
      cause: "failed",
    });
    proc2.exit(2);

    await settle();
    expect(r.driver.state().ended).toBe(true);
    expect(r.spawner.calls).toHaveLength(2);
    expect(r.appliedCount("B")).toBe(0);
    expect(r.host.state().inputs.some((input) => input.id === "B")).toBe(true);
    expect(r.pref()).toMatchObject({ harness: "codex", model: "totally-bogus" });
    expect(r.logText()).toContain("unknown-model");
  });
});

describe("RFC-12: the turn profile honors model and effort", () => {
  test("a changed model and effort re-spawn the next turn with the new flags", async () => {
    const r = await openRig({ harness: "codex" });
    const proc1 = r.procs[0] as FakeHcnProcess;

    r.send("A");
    await until(() => r.spawner.calls.length >= 1, "the first turn spawn");
    proc1.emit(identity("codex-sess-1"));
    proc1.emit(assistant("turn one"));
    proc1.emit(doneClean);
    proc1.exit(0);
    await settle();

    r.writePref({ harness: "codex", model: "gpt-6", effort: "high" });
    r.send("B");
    const proc2 = r.procs[1] as FakeHcnProcess;
    await until(() => r.spawner.calls.length >= 2, "the switch spawn");
    expect(r.argvOf(1)).toEqual(
      expect.arrayContaining(["--model", "gpt-6", "--effort", "high", "--resume", "codex-sess-1"]),
    );
    proc2.emit(identity("codex-sess-2"));
    proc2.emit(assistant("turn two on the new model"));
    proc2.emit(doneClean);
    proc2.exit(0);
    await settle();

    expect(r.appliedCount("B")).toBe(1);
    expect(r.logText()).toContain("turn two on the new model");
    expect(r.driver.state().spawn).toEqual({
      harness: "codex",
      model: "gpt-6",
      effort: "high",
    });
  });
});

describe("RFC-12: the pin and the startup fold", () => {
  test("a harness named at spawn is pinned for the process's life: the preference cannot switch it", async () => {
    const r = await openRig({ harness: "claude", pinned: true });
    const proc1 = r.procs[0] as FakeHcnProcess;
    sessionLine(proc1, SID);

    r.writePref({ harness: "pi" });
    r.send("A");
    await until(
      () => proc1.commands.some((c) => c.op === "send" && c.id === "A"),
      "A on the pinned harness",
    );
    accept(proc1, "A", "hcn-t1");
    proc1.emit(assistant("still claude"));
    proc1.emit(doneClean);
    await settle();

    expect(r.spawner.calls.length).toBe(1);
    expect(r.appliedCount("A")).toBe(1);
    expect(r.logText()).toContain("still claude");
  });

  test("a preference already in the record names the first spawn's model", async () => {
    // Written before the driver starts, the way the server writes it while
    // nothing runs: the startup fold must carry every dimension.
    const root = mkdtempSync(join(tmpdir(), "lucid-honor-start-"));
    const dir = join(root, "conv-1");
    const { secret } = createConversationRecord(root, "conv-1");
    writeDriverPreference(dir, { harness: "claude", model: "claude-opus-5", effort: "high" });
    const procs = [new FakeHcnProcess()];
    const spawner = fakeSpawner([...procs]);

    let receive: (frame: Frame) => void = () => {};
    const host = openConversation(dir, {
      now: () => 0,
      presence: () => undefined,
      executorLease: () => true,
      onRecord: () => {},
      onEffect: (e) => {
        if (e.type === "send") receive(e.frame);
      },
    });
    let turnCount = 0;
    const driver = await openHonoringDriver({
      base: {
        conversationId: "conv-1",
        secret,
        runner: createHcnRunner({ spawn: spawner.spawn, bin: BIN }),
        host: fakeArtifactHost(),
        mintTurnId: () => `turn-${++turnCount}`,
        sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
      },
      sessionCapable: (h) => Promise.resolve(SESSION_CAPABLE[h]),
      initialHarness: "claude",
      harnessPinned: false,
      readPreference: () => readDriverPreference(dir),
      mintSessionId: () => "sess-1",
      createHostFn: createHeadlessHost,
    });
    receive = driver.receive;

    const proc = procs[0] as FakeHcnProcess;
    sessionLine(proc, SID);
    const input = host.enqueueInput({ id: "A", text: "hello", mode: "queue" });
    expect(input.verdict).toBe("accepted");
    await until(() => proc.commands.some((c) => c.op === "send" && c.id === "A"), "A dispatched");
    accept(proc, "A", "hcn-t1");
    proc.emit(assistant("under the chosen model"));
    proc.emit(doneClean);
    await settle();

    // Every dimension reached the spawn: the model and the effort, on
    // the session surface too since hcn 0.6.0.
    expect(spawner.calls[0]?.argv).toEqual([
      BIN,
      "session",
      "claude",
      "--json",
      "--session-id",
      "sess-1",
      "--model",
      "claude-opus-5",
      "--effort",
      "high",
    ]);
    expect(driver.state().spawn).toEqual({
      harness: "claude",
      model: "claude-opus-5",
      effort: "high",
    });
  });
});

test("credit arriving during a driver switch reaches the replacement", async () => {
  let opened = 0;
  let inspectCount = 0;
  let resumeInspect!: (value: boolean) => void;
  let endSource: Parameters<typeof createHeadlessHost>[0]["onEnded"];
  const delivered: Frame[][] = [];
  const driver = await openHonoringDriver({
    base: {
      conversationId: "switch-credit",
      secret: "test-secret",
      runner: createHcnRunner({ spawn: fakeSpawner([]).spawn, bin: BIN }),
      mintTurnId: () => "turn-1",
      host: fakeArtifactHost(),
      sendFrame: () => ({ verdict: "refused", issue: "not-used" }),
    },
    sessionCapable: async () =>
      ++inspectCount === 1
        ? true
        : new Promise<boolean>((resolve) => {
            resumeInspect = resolve;
          }),
    initialHarness: "claude",
    harnessPinned: false,
    readPreference: () => null,
    mintSessionId: () => "session",
    createHostFn: (deps) => {
      const frames: Frame[] = [];
      delivered.push(frames);
      opened += 1;
      endSource = deps.onEnded;
      return { receive: (frame) => frames.push(frame), close: () => {} };
    },
  });
  endSource?.({ kind: "driver-change" });
  const credit: Frame = { kind: "credit", epoch: 2, tokens: 17 };
  driver.receive(credit);
  resumeInspect(true);
  await until(() => opened === 2, "replacement source");
  expect(delivered[0]).toEqual([]);
  expect(delivered[1]).toEqual([credit]);
  driver.close();
});

test("credit arriving after a late refusal does not revive an ended driver", async () => {
  let endSource: Parameters<typeof createHeadlessHost>[0]["onEnded"];
  const delivered: Frame[][] = [];
  const driver = await openHonoringDriver({
    base: {
      conversationId: "fallback-credit",
      secret: "test-secret",
      runner: createHcnRunner({ spawn: fakeSpawner([]).spawn, bin: BIN }),
      mintTurnId: () => "turn-1",
      host: fakeArtifactHost(),
      sendFrame: () => ({ verdict: "refused", issue: "not-used" }),
    },
    sessionCapable: async () => true,
    initialHarness: "claude",
    harnessPinned: false,
    readPreference: () => null,
    mintSessionId: () => "session",
    createHostFn: (deps) => {
      const frames: Frame[] = [];
      delivered.push(frames);
      endSource = deps.onEnded;
      return { receive: (frame) => frames.push(frame), close: () => {} };
    },
  });
  try {
    endSource?.({ kind: "driver-change" });
    await until(() => delivered.length === 2, "replacement source");
    endSource?.({ kind: "open-refused", message: "synthetic late refusal" });
    const credit: Frame = { kind: "credit", epoch: 3, tokens: 23 };
    driver.receive(credit);
    await settle();
    expect(driver.state().ended).toBe(true);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toEqual([]);
  } finally {
    driver.close();
  }
});
