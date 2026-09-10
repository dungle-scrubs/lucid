import { describe, expect, test } from "bun:test";
import { decodeHarnessLine } from "../../src/harness/events.js";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { nodeSpawnHcn } from "../../src/harness/node-deps.js";
import { HarnessRefusal } from "../../src/harness/runner.js";

const SYNTHETIC_HCN_IDENTITY = "synthetic";

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
    expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
    expect(r.spawner.calls[0]?.argv).toEqual([
      BIN,
      "run",
      "claude",
      "--json",
      "--prompt-file",
      "-",
    ]);
    expect(r.proc.writes.join("")).toBe("hi");
    expect(r.proc.inputEnded).toBe(true);
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
      hcn: SYNTHETIC_HCN_IDENTITY,
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
      hcn: SYNTHETIC_HCN_IDENTITY,
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
      hcn: SYNTHETIC_HCN_IDENTITY,
      escalateQuestions: true,
    });
    const session = await opening;

    const first = session.send("in-1", "one");
    const second = session.send("in-2", "two");
    await tick();
    // Answer them out of order: each waiter is keyed by its own id.
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "rejected", reason: "busy" });
    r.proc.emit({ kind: "disposition", id: "in-1", disposition: "started" });
    expect(await second).toEqual({
      disposition: "rejected",
      reason: "busy",
      rejectionEvidence: "harness-refusal",
    });
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
      hcn: SYNTHETIC_HCN_IDENTITY,
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
      hcn: SYNTHETIC_HCN_IDENTITY,
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
    expect(await sent).toEqual({
      disposition: "rejected",
      reason: "write-failed",
      rejectionEvidence: "harness-refusal",
    });
  });

  test("answer sends the answer op, so hcn composes the preamble", async () => {
    const r = rig();
    const opening = r.runner.openSession({ harness: "claude", sessionId: sid });
    r.proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: SYNTHETIC_HCN_IDENTITY,
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
      hcn: SYNTHETIC_HCN_IDENTITY,
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
    expect(r.proc.inputEnded).toBe(true);
    expect(r.proc.signals).toEqual(["SIGTERM"]);
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
      hcn: SYNTHETIC_HCN_IDENTITY,
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
  test.each([
    [{ kind: "auto-compaction", modes: ["headless-turn"] }, true],
    [{ kind: "auto-compaction", modes: ["headless-turn", "headless-session"] }, true],
    [{ kind: "native-session-auto-compaction", modes: ["headless-turn"] }, true],
    [{ kind: "native-session-auto-compaction", modes: ["headless-turn", "headless-turn"] }, false],
    [
      { kind: "native-session-auto-compaction", modes: ["headless-turn", "headless-session"] },
      false,
    ],
    [{ kind: "native-session-auto-compaction", modes: ["headless-session"] }, false],
    [null, false],
    [undefined, false],
    [{ kind: "unknown", modes: ["headless-turn"] }, false],
    [{ kind: "auto-compaction", modes: ["headless-turn", "unknown"] }, false],
    [{ kind: "auto-compaction", modes: ["headless-session"] }, false],
    [{ kind: "auto-compaction", modes: "headless-turn" }, false],
    [[], false],
  ])(
    "native context management requires a known complete declaration %j",
    async (declaration, supported) => {
      const r = rig();
      const pending = r.runner.inspect("codex");
      // Synthetic descriptor variations, not recorded harness events.
      r.proc.emitRaw(
        JSON.stringify({
          name: "codex",
          verifiedAgainst: "0.153.4",
          nativeContextManagement: declaration,
        }),
      );
      r.proc.exit(0);
      expect((await pending).nativeContextManagement as string | undefined).toBe(
        supported && declaration && "kind" in declaration ? declaration.kind : undefined,
      );
    },
  );

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
    expect(await pending).toEqual({ name: "claude", session: true });
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
      vocabulary: {
        aliases: { glm: "zai/glm-5.2" },
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
      aliases: {},
      models: ["gpt-5.6-sol"],
      efforts: [],
      extensible: false,
    });
  });
});

describe("review fixes: what the cross-family review found", () => {
  const sid2 = "479c05c6-0c2b-416a-9700-2b04cf8ecf24";
  const open = async (r: ReturnType<typeof rig>, hcn = SYNTHETIC_HCN_IDENTITY) => {
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

  test.each(["0.0.1", "999.0.0", "unknown", ""])(
    "session admission ignores HCN version metadata: %s",
    async (version) => {
      const r = rig();
      const session = await open(r, version);
      expect(r.proc.signals).toEqual([]);
      expect(typeof session.send).toBe("function");
      r.proc.exit(0);
      await session.close();
    },
  );

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
  test("abandonment waits for process cleanup before returning to the directory owner", async () => {
    let exited = false;
    class SlowExit extends FakeHcnProcess {
      override kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
        this.signals.push(signal);
        setTimeout(() => {
          exited = true;
          this.exit(null);
        }, 5);
      }
    }
    const r = rig([new SlowExit()]);
    const iterator = r.runner
      .streamTurn({
        harness: "claude",
        prompt: "Summary",
        turnId: "summary",
        isolation: "tool-free",
      })
      [Symbol.asyncIterator]();
    r.proc.emit({ kind: "token", text: "too much output" });
    await iterator.next();
    await iterator.return?.();
    expect(exited).toBe(true);
  });
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

test("a large prepared prompt crosses the real hcn process boundary over stdin", async () => {
  // Synthetic peer implements the public hcn stream, not a native harness.
  const peer =
    'const text = await Bun.stdin.text(); console.log(JSON.stringify({kind:"message", role:"assistant", text:String(text.length)})); console.log(JSON.stringify({kind:"done", exitCode:0, cause:"clean"}));';
  const runner = createHcnRunner({
    bin: "/synthetic/hcn",
    spawn: (argv, opts) =>
      nodeSpawnHcn([process.execPath, "-e", peer, "--", ...argv.slice(1)], opts),
  });
  const events = [];
  for await (const event of runner.streamTurn({
    harness: "claude",
    prompt: "x".repeat(1024 * 1024),
    turnId: "large-prompt",
  }))
    events.push(event);
  expect(events).toContainEqual({ kind: "message", role: "assistant", text: "1048576" });
  expect(events.at(-1)).toMatchObject({ kind: "done", cause: "clean" });
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
      hcn: SYNTHETIC_HCN_IDENTITY,
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

test("a refused child that ignores SIGTERM is killed before the refusal returns", async () => {
  class ResistantProcess extends FakeHcnProcess {
    override kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
      this.signals.push(signal);
      if (signal === "SIGKILL") this.exit(null);
    }
  }
  const proc = new ResistantProcess();
  const runner = createHcnRunner({ spawn: fakeSpawner([proc]).spawn, bin: BIN, refusalGraceMs: 0 });
  const opening = runner.openSession({ harness: "codex", sessionId: "session" });
  for (const e of fixtureEvents("session-refusal-no-session-mode")) proc.emit(e);
  // Cleanup also bounds the RED run, without making its missing SIGKILL pass.
  const cleanup = setTimeout(() => proc.exit(2), 50);
  try {
    await expect(opening).rejects.toBeInstanceOf(HarnessRefusal);
    expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
  } finally {
    clearTimeout(cleanup);
    proc.exit(2);
  }
});

test("closing an opened session through its signal allows the graceful close reply", async () => {
  const r = rig();
  const controller = new AbortController();
  const opening = r.runner.openSession({
    harness: "claude",
    sessionId: "graceful",
    signal: controller.signal,
  });
  r.proc.emit({
    kind: "session",
    sessionId: "graceful",
    harness: "claude",
    hcn: SYNTHETIC_HCN_IDENTITY,
  });
  const session = await opening;
  try {
    controller.abort();
    expect(r.proc.commands.at(-1)).toEqual({ op: "close" });
    expect(r.proc.signals).toEqual([]);
    r.proc.emit({ kind: "closed", exitCode: 0, cause: "clean" });
    r.proc.exit(0);
    expect(await session.close()).toEqual({ exitCode: 0, cause: "clean" });
  } finally {
    r.proc.exit(0);
  }
});

test("aborting session startup settles the open and terminates its silent child", async () => {
  const r = rig();
  const controller = new AbortController();
  const opening = r.runner.openSession({
    harness: "claude",
    sessionId: "quiet",
    signal: controller.signal,
  });
  void opening.catch(() => {});
  controller.abort();
  await Promise.resolve();
  try {
    expect(r.proc.signals).toEqual(["SIGTERM"]);
    r.proc.exit(null);
    await expect(opening).rejects.toMatchObject({ issue: "aborted" });
  } finally {
    r.proc.exit(null);
    await opening.catch(() => {});
  }
});

test("aborting a quiet turn terminates its process while a read is pending", async () => {
  const r = rig();
  const controller = new AbortController();
  const turn = r.runner.streamTurn({
    harness: "claude",
    prompt: "Continue",
    signal: controller.signal,
    turnId: "cancel-quiet",
  });
  const iterator = turn[Symbol.asyncIterator]();
  const pending = iterator.next();
  try {
    controller.abort();
    expect(r.proc.signals).toEqual(["SIGTERM"]);
  } finally {
    r.proc.exit(null);
    await pending;
    await iterator.return?.();
  }
});

test("an aborted turn that ignores SIGTERM is killed and releases its reader", async () => {
  class ResistantProcess extends FakeHcnProcess {
    override kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
      this.signals.push(signal);
      if (signal === "SIGKILL") this.exit(null);
    }
  }
  const proc = new ResistantProcess();
  const controller = new AbortController();
  const runner = createHcnRunner({ spawn: fakeSpawner([proc]).spawn, bin: BIN, refusalGraceMs: 0 });
  const iterator = runner
    .streamTurn({
      harness: "claude",
      prompt: "continue",
      turnId: "resistant",
      signal: controller.signal,
    })
    [Symbol.asyncIterator]();
  const reading = iterator.next();
  const cleanup = setTimeout(() => proc.exit(null), 50);
  try {
    controller.abort();
    await reading;
    expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
  } finally {
    clearTimeout(cleanup);
    proc.exit(null);
    await iterator.return?.();
  }
});

test("malformed runtime inspection is a typed settings refusal", async () => {
  const r = rig();
  const checking = r.runner.inspect("claude", {
    model: "concrete-opus",
    effort: "high",
    runtime: { cwd: "/saved", profile: "headless-turn", resume: "native" },
  });
  r.proc.emitRaw("not json");
  r.proc.exit(0);
  await expect(checking).rejects.toMatchObject({ issue: "invalid-settings" });
});

test("settings inspection validates argv, propagates refusal, and reuses descriptor facts", async () => {
  // Inline inspection responses: these are command results, not fabricated NDJSON fixtures.
  const facts = new FakeHcnProcess();
  const valid = new FakeHcnProcess();
  const refused = new FakeHcnProcess();
  const r = rig([facts, valid, refused]);
  const first = r.runner.inspect("claude");
  facts.emitRaw(JSON.stringify({ name: "claude", sessionMode: {}, verifiedAgainst: "fake" }));
  facts.exit(0);
  await first;
  const checked = r.runner.inspect("claude", { model: "concrete-opus", effort: "high" });
  valid.emitRaw("[]");
  valid.exit(0);
  expect(await checked).toMatchObject({ name: "claude", session: true });
  expect(r.spawner.calls[1]?.argv).toEqual([
    BIN,
    "inspect",
    "claude",
    "--argv",
    "--prompt",
    "Validate settings",
    "--model",
    "concrete-opus",
    "--effort",
    "high",
  ]);
  expect(await r.runner.inspect("claude")).toMatchObject({ name: "claude" });
  expect(r.spawner.calls).toHaveLength(2);
  const rejected = r.runner.inspect("claude", { model: "invalid", effort: "high" });
  refused.emitRaw("invalid settings");
  refused.exit(2);
  await expect(rejected).rejects.toBeInstanceOf(HarnessRefusal);
  expect(r.spawner.calls).toHaveLength(3);
});

test.each(["supported", "unknown"] as const)(
  "native resume inspection trusts HCN status %s despite version metadata",
  async (status) => {
    const facts = new FakeHcnProcess();
    const checked = new FakeHcnProcess();
    const r = rig([facts, checked]);
    const initial = r.runner.inspect("claude");
    facts.emitRaw(JSON.stringify({ name: "claude", sessionMode: {}, verifiedAgainst: "2.1.233" }));
    facts.exit(0);
    await initial;
    const query = r.runner.inspect("claude", {
      model: "concrete-opus",
      effort: "high",
      runtime: { cwd: "/saved/nested", resume: "native-id", profile: "headless-turn" },
    });
    checked.emitRaw(
      JSON.stringify({
        v: 1,
        argv: ["claude", "--resume", "native-id"],
        executable: { path: "/selected/claude", version: "2.9.0" },
        verifiedAgainst: "0.0.1",
        resume: { status, reason: null },
      }),
    );
    checked.exit(0);
    expect((await query).runtime).toMatchObject({
      executable: { path: "/selected/claude" },
      resume: { status },
    });
    expect(r.spawner.calls[1]?.argv).toEqual([
      BIN,
      "inspect",
      "claude",
      "--runtime",
      "--prompt",
      "Validate settings",
      "--model",
      "concrete-opus",
      "--effort",
      "high",
      "--resume",
      "native-id",
      "--mode",
      "headless-turn",
    ]);
    expect(r.spawner.calls[1]?.opts.cwd).toBe("/saved/nested");
  },
);

test("isolated naming asks hcn to enforce isolation, bounds runtime, and refuses resume", async () => {
  const r = rig();
  const turn = r.runner.streamTurn({
    harness: "claude",
    prompt: "Name quoted data",
    turnId: "naming",
    isolation: "tool-free",
    model: "opus",
    effort: "high",
    cwd: "/isolated",
  });
  r.proc.emitFixture("run-clean");
  r.proc.exit(0);
  for await (const _event of turn) {
    /* Drain recorded evidence. */
  }
  expect(r.spawner.calls[0]?.argv).toContain("--isolation");
  expect(r.spawner.calls[0]?.argv).toContain("tool-free");
  expect(r.spawner.calls[0]?.argv).toContain("--timeout");
  expect(r.spawner.calls[0]?.argv).toContain("--prompt-file");
  expect(r.spawner.calls[0]?.argv).not.toContain("Name quoted data");
  expect(r.proc.writes.join("")).toBe("Name quoted data");
  expect(r.proc.inputEnded).toBe(true);
  expect(() =>
    r.runner.streamTurn({
      harness: "claude",
      prompt: "Name",
      turnId: "bad",
      isolation: "tool-free",
      resume: "working-session",
    }),
  ).toThrow("resume");
  const check = rig();
  const result = check.runner.inspect("claude", {
    model: "opus",
    effort: "high",
    isolation: "tool-free",
  });
  check.proc.emit('{"error":"unsupported-option"}\n');
  check.proc.exit(2);
  await expect(result).rejects.toBeInstanceOf(HarnessRefusal);
  expect(check.spawner.calls[0]?.argv).toContain("--isolation");
});

test("inspection has a deadline and closes silent child output", async () => {
  const proc = new FakeHcnProcess();
  const runner = createHcnRunner({
    bin: "/fake/hcn",
    spawn: fakeSpawner([proc]).spawn,
    inspectionTimeoutMs: 5,
    refusalGraceMs: 1,
  });
  await expect(runner.inspect("claude")).rejects.toThrow("inspection timed out");
  expect(proc.signals).toEqual(["SIGTERM"]);
});

test("cancelled inspection does not spawn and in-flight cancellation cleans up", async () => {
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const runner = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn, refusalGraceMs: 1 });
  const abort = new AbortController();
  const pending = runner.inspect("claude", { signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toThrow("inspection cancelled");
  expect(proc.signals).toEqual(["SIGTERM"]);
  await expect(runner.inspect("claude", { signal: abort.signal })).rejects.toThrow(
    "inspection cancelled",
  );
  expect(spawner.calls).toHaveLength(1);
});

test("inspection bounds a response even when it contains no newline", async () => {
  const proc = new FakeHcnProcess();
  const runner = createHcnRunner({
    bin: "/fake/hcn",
    spawn: fakeSpawner([proc]).spawn,
    refusalGraceMs: 1,
  });
  const pending = runner.inspect("claude");
  proc.stdoutChannel.push("x".repeat(1_048_577));
  await expect(pending).rejects.toThrow("inspection response exceeded its limit");
  expect(proc.signals).toEqual(["SIGTERM"]);
});

test("failed descriptor inspection does not poison a later explicit inspection", async () => {
  const first = new FakeHcnProcess();
  const second = new FakeHcnProcess();
  const spawner = fakeSpawner([first, second]);
  const runner = createHcnRunner({
    bin: "/fake/hcn",
    spawn: spawner.spawn,
    inspectionTimeoutMs: 5,
    refusalGraceMs: 1,
  });
  await expect(runner.inspect("claude")).rejects.toThrow("inspection timed out");
  const retried = runner.inspect("claude");
  second.emit({ sessionMode: null, verifiedAgainst: "test" });
  second.exit(0);
  expect(await retried).toMatchObject({ session: false });
  expect(spawner.calls).toHaveLength(2);
});

test("structured run refusals retain their issue without forwarding process prose", async () => {
  const proc = new FakeHcnProcess();
  const { runner } = rig([proc]);
  // Synthetic refusal, not a recording. Private text must not become feedback.
  proc.emit({
    kind: "failure",
    class: "rejected",
    retryable: false,
    issue: "unsupported-option",
    message: "synthetic-private-process-output",
  });
  proc.emit({ kind: "done", cause: "failed", exitCode: 2 });
  proc.exit(2);
  const events = [];
  for await (const event of runner.streamTurn({
    harness: "claude",
    model: "selected",
    turnId: "test",
    prompt: "synthetic",
  }))
    events.push(event);
  expect(JSON.stringify(events)).not.toContain("synthetic-private-process-output");
  expect(events[0]).toMatchObject({
    kind: "failure",
    class: "rejected",
    issue: "unsupported-option",
    compatibility: { code: "selection-unsupported", origin: "execution-check" },
  });
});
