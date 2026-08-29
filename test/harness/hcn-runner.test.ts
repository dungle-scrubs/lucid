import { describe, expect, test } from "bun:test";
import { decodeHarnessLine } from "../../src/harness/events.js";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { HarnessRefusal, HarnessVersionError } from "../../src/harness/runner.js";
import { FakeHcnProcess, fakeSpawner, fixtureEvents } from "./fakes.js";

const BIN = "/fake/hcn";
const rig = (procs: FakeHcnProcess[] = [new FakeHcnProcess()]) => {
  const spawner = fakeSpawner(procs);
  const runner = createHcnRunner({ spawn: spawner.spawn, bin: BIN });
  return { runner, spawner, proc: procs[0] as FakeHcnProcess };
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("decoding hcn's stream", () => {
  test("a known kind decodes to itself", () => {
    expect(decodeHarnessLine('{"kind":"message","role":"assistant","text":"hi"}')).toMatchObject({
      kind: "message",
      text: "hi",
    });
  });

  test("an unknown kind is carried, not dropped and not thrown on", () => {
    // hcn promises additive kinds; a decoder that refused one would turn a
    // normalizer release into an outage.
    const e = decodeHarnessLine('{"kind":"telemetry","spanId":"abc"}');
    expect(e).toMatchObject({ kind: "telemetry", spanId: "abc" });
  });

  test("a line that is not an event decodes to null rather than throwing", () => {
    expect(decodeHarnessLine("not json")).toBeNull();
    expect(decodeHarnessLine("[1,2,3]")).toBeNull();
    expect(decodeHarnessLine('{"no":"kind"}')).toBeNull();
    expect(decodeHarnessLine("")).toBeNull();
  });
});

describe("streamTurn over hcn run --json", () => {
  test("a recorded clean run yields its events in order and ends with done", async () => {
    const r = rig();
    const events: unknown[] = [];
    const pull = (async () => {
      for await (const e of r.runner.streamTurn({
        harness: "claude",
        prompt: "hi",
        turnId: "turn-1",
      })) {
        events.push(e);
      }
    })();
    r.proc.emitFixture("run-clean");
    r.proc.exit(0);
    await pull;

    const recorded = fixtureEvents("run-clean");
    // Same events, same order, same content - a length check alone would
    // pass on a decoder that mangled every field.
    expect(events).toEqual(recorded);
    expect((events.at(-1) as { kind: string }).kind).toBe("done");
    expect(r.spawner.calls[0]?.argv).toEqual([BIN, "run", "claude", "--json", "hi"]);
  });

  test("resume and model reach the argv", async () => {
    const r = rig();
    const it = r.runner
      .streamTurn({
        harness: "claude",
        prompt: "hi",
        turnId: "t",
        resume: "sess-1",
        model: "sonnet",
      })
      [Symbol.asyncIterator]();
    r.proc.exit(0);
    await it.next();
    const argv = r.spawner.calls[0]?.argv ?? [];
    expect(argv).toContain("--resume");
    expect(argv).toContain("sess-1");
    expect(argv).toContain("--model");
  });
});

describe("openSession over hcn session --json", () => {
  const sid = "479c05c6-0c2b-416a-9700-2b04cf8ecf24";

  test("a recorded two-turn session regroups into turns tagged by input id", async () => {
    // Read the ids out of the recording rather than hardcoding them: a
    // fixture re-capture changes the session id, and a test that pins it
    // fails for the wrong reason.
    const recorded = fixtureEvents("session-two-turns");
    const recordedSid = String(
      (recorded.find((e) => e.kind === "session") as { sessionId?: string } | undefined)
        ?.sessionId ?? sid,
    );
    const firstTurnId = String(
      (recorded.find((e) => e.kind === "turn") as { turnId?: string } | undefined)?.turnId ?? "",
    );
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
    const session = await opening;

    const seen: { turnId: string; inputId?: string; kinds: string[] }[] = [];
    const reading = (async () => {
      for await (const turn of session.turns) {
        const kinds: string[] = [];
        for await (const e of turn) kinds.push(e.kind);
        seen.push({
          turnId: turn.turnId,
          ...(turn.inputId === undefined ? {} : { inputId: turn.inputId }),
          kinds,
        });
      }
    })();

    // Replay the recording minus its session line, which is already consumed.
    for (const e of fixtureEvents("session-two-turns")) {
      if (e.kind === "session") continue;
      r.proc.emit(e);
    }
    r.proc.exit(0);
    await reading;

    expect(seen).toHaveLength(2);
    expect(seen[0]?.inputId).toBe("in-1");
    expect(seen[1]?.inputId).toBe("in-2");
    expect(seen[0]?.turnId).toBe(firstTurnId);
    expect(firstTurnId).toBe(`${recordedSid}:turn-1`);
    // Each turn's events land inside it, ending with that turn's done.
    expect(seen[0]?.kinds.at(-1)).toBe("done");
    expect(seen[1]?.kinds.at(-1)).toBe("done");
    // Every event of a turn lands inside that turn and nowhere else.
    expect(seen[0]?.kinds).toContain("message");
    expect(seen[1]?.kinds).toContain("message");
  });

  test("send writes a command and resolves with the disposition hcn reports", async () => {
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
    const session = await opening;

    const sent = session.send("in-1", "hello");
    await tick();
    expect(r.proc.commands.at(-1)).toEqual({ op: "send", id: "in-1", text: "hello" });
    r.proc.emit({ kind: "disposition", id: "in-1", disposition: "started" });
    expect(await sent).toEqual({ disposition: "started" });
  });

  test("a disposition resolves its own send, not another", async () => {
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
    const session = await opening;

    const first = session.send("in-1", "one");
    const second = session.send("in-2", "two");
    await tick();
    // Answer them out of order: each waiter is keyed by its own id.
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "rejected", reason: "busy" });
    r.proc.emit({ kind: "disposition", id: "in-1", disposition: "started" });
    expect(await second).toEqual({ disposition: "rejected", reason: "busy" });
    expect(await first).toEqual({ disposition: "started" });
  });

  test("a disposition hcn does not have is refused, not passed through", async () => {
    // hcn answers `started` or `rejected`. If it ever grows a third, lucid
    // must not read it as one of the two it knows - marking a turn started
    // that never opened would strand the pump waiting for events. Refusing
    // names the value instead, so the log says what arrived.
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.6",
      escalateQuestions: true,
    });
    const session = await opening;

    const sent = session.send("in-1", "one");
    await tick();
    r.proc.emit({ kind: "disposition", id: "in-1", disposition: "queued" });
    expect(await sent).toEqual({
      disposition: "rejected",
      reason: "unknown disposition: queued",
    });
  });

  test("a rejected send carries its reason", async () => {
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
    const session = await opening;

    const sent = session.send("in-1", "unwritable");
    await tick();
    r.proc.emit({
      kind: "disposition",
      id: "in-1",
      disposition: "rejected",
      reason: "write-failed",
    });
    expect(await sent).toEqual({ disposition: "rejected", reason: "write-failed" });
  });

  test("answer sends the answer op, so hcn composes the preamble", async () => {
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
    const session = await opening;

    void session.answer("in-2", "prod");
    await tick();
    expect(r.proc.commands.at(-1)).toEqual({ op: "answer", id: "in-2", text: "prod" });
  });

  test("close reports the closed event's exit code and cause", async () => {
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
    const session = await opening;

    const closing = session.close();
    await tick();
    expect(r.proc.commands.at(-1)).toEqual({ op: "close" });
    r.proc.emit({ kind: "closed", exitCode: 0, cause: "clean" });
    r.proc.exit(0);
    expect(await closing).toEqual({ exitCode: 0, cause: "clean" });
  });

  test("a refusal before the session line throws, using the recorded refusal", async () => {
    const r = rig();
    const opening = r.runner.openSession({ harness: "codex", sessionId: sid });
    for (const e of fixtureEvents("session-refusal-no-session-mode")) r.proc.emit(e);
    r.proc.exit(2);
    await expect(opening).rejects.toBeInstanceOf(HarnessRefusal);
  });

  test("the session argv carries the id, provider and stall budget", async () => {
    const r = rig();
    const opening = r.runner.openSession({
      harness: "pi",
      sessionId: sid,
      provider: "lmstudio",
      stallSeconds: 30,
    });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "pi",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
    await opening;
    const argv = r.spawner.calls[0]?.argv ?? [];
    expect(argv).toEqual([
      BIN,
      "session",
      "pi",
      "--json",
      "--session-id",
      sid,
      "--provider",
      "lmstudio",
      "--stall",
      "30",
    ]);
  });
});

describe("inspection, which never spawns a harness", () => {
  test("capabilities parses the recorded record", async () => {
    const r = rig();
    const pending = r.runner.capabilities("claude", "", "headless-turn");
    r.proc.emitFixture("inspect-capabilities-claude");
    r.proc.exit(0);
    expect(await pending).toMatchObject({ session: true, source: "curated" });
    expect(r.spawner.calls[0]?.argv).toEqual([
      BIN,
      "inspect",
      "claude",
      "--capabilities",
      "--mode",
      "headless-turn",
    ]);
  });

  test("inspect reads session support off the descriptor", async () => {
    const r = rig();
    const pending = r.runner.inspect("claude");
    r.proc.emitRaw(
      JSON.stringify({ name: "claude", sessionMode: { flags: [] }, verifiedAgainst: "2.1.233" }),
    );
    r.proc.exit(0);
    expect(await pending).toEqual({ name: "claude", session: true, verifiedAgainst: "2.1.233" });
  });

  test("a harness with no session mode reports session false", async () => {
    const r = rig();
    const pending = r.runner.inspect("codex");
    r.proc.emitRaw(JSON.stringify({ name: "codex", sessionMode: null, verifiedAgainst: "0.9.0" }));
    r.proc.exit(0);
    expect((await pending).session).toBe(false);
  });

  // The dumps below are composed inline rather than replayed from
  // test/fixtures/hcn: no recording shows a vocabulary, and a descriptor
  // dump is one JSON object, not an event stream a recording would prove.
  test("inspect reads the choosing vocabulary off the descriptor (RFC-12)", async () => {
    const r = rig();
    const pending = r.runner.inspect("pi");
    r.proc.emitRaw(
      JSON.stringify({
        name: "pi",
        sessionMode: { flags: [] },
        verifiedAgainst: "0.84.2",
        vocabulary: {
          models: ["zai/glm-5.2"],
          aliases: { glm: "zai/glm-5.2" },
          efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          extensible: true,
        },
        turnOptions: { effort: {}, provider: {} },
      }),
    );
    r.proc.exit(0);
    expect(await pending).toEqual({
      name: "pi",
      session: true,
      verifiedAgainst: "0.84.2",
      vocabulary: {
        // models as the dump lists them - the canonical ids the aliases
        // resolve onto, served as they stand.
        models: ["zai/glm-5.2"],
        efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        extensible: true,
        provider: true,
      },
    });
  });

  test("a harness without the provider turn option carries no provider key", async () => {
    const r = rig();
    const pending = r.runner.inspect("claude");
    r.proc.emitRaw(
      JSON.stringify({
        name: "claude",
        sessionMode: { flags: [] },
        verifiedAgainst: "2.1.233",
        vocabulary: {
          models: ["claude-opus-5"],
          efforts: ["low", "medium", "high"],
          extensible: false,
        },
        turnOptions: { effort: {} },
      }),
    );
    r.proc.exit(0);
    const facts = await pending;
    // Absent, not false: "provider" missing from the entry is what tells
    // the page the dimension does not exist for this harness.
    expect("provider" in (facts.vocabulary ?? {})).toBe(false);
    expect(facts.vocabulary?.extensible).toBe(false);
  });

  test("a dump with no vocabulary leaves the facts without one", async () => {
    const r = rig();
    const pending = r.runner.inspect("muse");
    r.proc.emitRaw(JSON.stringify({ name: "muse", sessionMode: null, verifiedAgainst: "1.0" }));
    r.proc.exit(0);
    const facts = await pending;
    expect("vocabulary" in facts).toBe(false);
  });

  test("a vocabulary of the wrong shape is narrowed, not cast", async () => {
    const r = rig();
    const pending = r.runner.inspect("codex");
    r.proc.emitRaw(
      JSON.stringify({
        name: "codex",
        sessionMode: null,
        verifiedAgainst: "0.9.0",
        vocabulary: { models: ["gpt-5.6-sol", 7, null], efforts: "many", extensible: "yes" },
        turnOptions: null,
      }),
    );
    r.proc.exit(0);
    expect((await pending).vocabulary).toEqual({
      models: ["gpt-5.6-sol"],
      efforts: [],
      extensible: false,
    });
  });
});

describe("review fixes: what the cross-family review found", () => {
  const sid2 = "479c05c6-0c2b-416a-9700-2b04cf8ecf24";
  const open = async (r: ReturnType<typeof rig>, hcn = "0.5.4") => {
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid2 });
    r.proc.emit({
      kind: "session",
      sessionId: sid2,
      harness: "claude",
      hcn,
      escalateQuestions: true,
    });
    return opening;
  };

  test("an hcn below the floor is refused by what the stream reports, not just the binary", async () => {
    const r = rig();
    // The binary was version-checked at resolution, but a stream can still
    // report an older protocol. That is the claim this checks.
    await expect(open(r, "0.5.3")).rejects.toBeInstanceOf(HarnessVersionError);
  });

  test("an event with no turn open is held for the next turn, never dropped", async () => {
    const r = rig();
    const session = await open(r);
    const seen: string[] = [];
    const reading = (async () => {
      for await (const turn of session.turns) {
        for await (const e of turn) seen.push(e.kind);
      }
    })();

    // hcn adds a kind lucid does not know, before any turn exists.
    r.proc.emit({ kind: "telemetry", spanId: "abc" });
    r.proc.emit({ kind: "turn", turnId: `${sid2}:turn-1`, id: "in-1" });
    r.proc.emit({ kind: "done", exitCode: null, cause: "clean" });
    r.proc.emit({ kind: "closed", exitCode: 0, cause: "clean" });
    r.proc.exit(0);
    await reading;

    // It rode into the turn rather than vanishing: the additive-kinds
    // promise holds at the seam, not only in the decoder.
    expect(seen).toEqual(["telemetry", "done"]);
  });

  test("a send still waiting when the session closes is answered, not left pending", async () => {
    const r = rig();
    const session = await open(r);
    const pending = session.send("in-1", "hello");
    await tick();
    // hcn closes without ever dispositioning that send.
    r.proc.emit({ kind: "closed", exitCode: 0, cause: "clean" });
    // No exit yet: the answer must not wait for the pipe to drain.
    expect(await pending).toEqual({ disposition: "rejected", reason: "closed" });
    r.proc.exit(0);
  });

  test("a turn line arriving while one is open closes the first, stranding nobody", async () => {
    const r = rig();
    const session = await open(r);
    const turnIds: string[] = [];
    const reading = (async () => {
      for await (const turn of session.turns) {
        turnIds.push(turn.turnId);
        for await (const _e of turn) {
          // drain
        }
      }
    })();

    // Back-to-back turns with no done between them.
    r.proc.emit({ kind: "turn", turnId: `${sid2}:turn-1`, id: "in-1" });
    r.proc.emit({ kind: "turn", turnId: `${sid2}:turn-2`, id: "in-2" });
    r.proc.emit({ kind: "done", exitCode: null, cause: "clean" });
    r.proc.emit({ kind: "closed", exitCode: 0, cause: "clean" });
    r.proc.exit(0);
    await reading;

    expect(turnIds).toEqual([`${sid2}:turn-1`, `${sid2}:turn-2`]);
  });
});

describe("an abandoned turn does not leave a child running", () => {
  test("breaking out of a turn's events kills the hcn process", async () => {
    const r = rig();
    const turn = r.runner.streamTurn({ harness: "claude", prompt: "hi", turnId: "t1" });
    const it = turn[Symbol.asyncIterator]();
    r.proc.emit({ kind: "identity", sessionId: "s", authority: "caller-assigned" });
    await it.next();

    // The consumer walks away mid-turn, which is what the host does when it
    // closes while a turn is streaming.
    await it.return?.(undefined);
    expect(r.proc.signals).toContain("SIGTERM");
  });

  test("a turn that runs to completion is not signalled", async () => {
    const r = rig();
    const events: unknown[] = [];
    const pull = (async () => {
      for await (const e of r.runner.streamTurn({
        harness: "claude",
        prompt: "hi",
        turnId: "t1",
      })) {
        events.push(e);
      }
    })();
    r.proc.emit({ kind: "done", exitCode: 0, cause: "clean" });
    r.proc.exit(0);
    await pull;

    expect(events).toHaveLength(1);
    expect(r.proc.signals).toHaveLength(0);
  });
});

describe("a turn that carries a failure still delivers its events", () => {
  const sid = "479c05c6-0c2b-416a-9700-2b04cf8ecf24";

  // Composed inline, not recorded: an earlier fixture happened to catch a
  // live rate-limit warning and a test leaned on it. That was luck, and the
  // next capture did not reproduce it. The behaviour is worth pinning, so it
  // is scripted rather than hoped for.
  test("a non-fatal failure rides with the turn's events", async () => {
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.6",
      escalateQuestions: true,
    });
    const session = await opening;

    const kinds: string[] = [];
    const reading = (async () => {
      for await (const turn of session.turns) {
        for await (const e of turn) kinds.push(e.kind);
      }
    })();
    r.proc.emit({ kind: "turn", turnId: `${sid}:turn-1`, id: "in-1" });
    r.proc.emit({
      kind: "failure",
      class: "rate-limit",
      retryable: true,
      message: "rate limit warning",
    });
    r.proc.emit({ kind: "message", role: "assistant", text: "answered anyway" });
    r.proc.emit({ kind: "done", exitCode: null, cause: "failed" });
    r.proc.emit({ kind: "closed", exitCode: 0, cause: "clean" });
    r.proc.exit(0);
    await reading;

    // The failure does not swallow the turn: the message still arrives.
    expect(kinds).toEqual(["failure", "message", "done"]);
  });
});
