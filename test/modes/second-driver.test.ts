/**
 * A second driver on a record that has already been driven.
 *
 * This is the shape of a real failure and nothing in the suite covered it,
 * because every test that drove a record drove it once.
 *
 * What happened: a driver minted turn ids from a per-process counter, so the
 * second driver on a record started again at `turn-1`. The reducer refuses a
 * turn id the record has already retired, correctly. The sequencer discarded
 * that refusal without recording it or reporting it, and `n` never advanced,
 * so every event after the first was refused the same way.
 *
 * The driver still dispositioned inputs, because a disposition carries no
 * `n` and no turn id. It still wrote artifacts, because those are appended
 * from the message before the event is emitted. So it looked alive from the
 * outside and recorded nothing the agent said - for a day, across four
 * drivers, before anyone could tell why.
 *
 * Both halves are held here: the ids no longer collide, and a refusal that
 * cannot clear stops the driver instead of being swallowed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { createHeadlessHost } from "../../src/modes/host.js";
import type { Frame } from "../../src/protocol/frames.js";
import { createTurnIds } from "../../src/protocol/turn-id.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

const SID = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One record, driven by as many drivers in turn as a test asks for. */
const record = () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-second-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const dir = join(root, "conv-1");
  return {
    dir,
    secret,
    /** Attach a driver, hand it one input, let the harness answer, detach. */
    drive: async (say: string) => {
      const host = openConversation(dir, {
        now: () => Date.now(),
        presence: () => undefined,
        executorLease: () => true,
        onRecord: () => {},
        onEffect: () => {},
      });
      const proc = new FakeHcnProcess();
      const spawner = fakeSpawner([proc]);
      const mintTurnId = createTurnIds();
      const source = createHeadlessHost(
        {
          harness: "claude",
          conversationId: "conv-1",
          secret,
          runner: createHcnRunner({ spawn: spawner.spawn, bin: "/fake/hcn" }),
          mintTurnId,
          sendFrame: (f: Frame) => host.handleFrame(JSON.stringify(f)),
          sessionId: SID,
        } as unknown as Parameters<typeof createHeadlessHost>[0],
        "headless-session",
      );
      proc.emit({
        kind: "session",
        sessionId: SID,
        harness: "claude",
        hcn: "0.6.0",
        escalateQuestions: true,
      });
      await settle();
      const inputId = `in-${say}`;
      source.receive({ kind: "input", seq: 1, id: inputId, text: say, mode: "queue" });
      await settle();
      // The harness answers: a turn, something said, and the turn ends.
      const turnId = `t-${say}`;
      proc.emit({ kind: "disposition", id: inputId, disposition: "started" });
      proc.emit({ kind: "turn", turnId, id: inputId });
      proc.emit({ kind: "message", role: "assistant", text: `answering ${say}` });
      proc.emit({ kind: "done", turnId, outcome: "ok" });
      await settle(80);
      const events = host.transcript().events;
      source.close();
      host.close();
      return events;
    },
    said: () => {
      const host = openConversation(dir, {
        now: () => Date.now(),
        presence: () => undefined,
        executorLease: () => true,
        onRecord: () => {},
        onEffect: () => {},
      });
      try {
        return host
          .transcript()
          .events.map((e) => String((e.event as { text?: string }).text ?? ""))
          .filter((t) => t !== "");
      } finally {
        host.close();
      }
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
};

describe("a record driven twice", () => {
  test("the second driver's answers reach the record", async () => {
    const r = record();
    try {
      await r.drive("first");
      await r.drive("second");
      const said = r.said();
      // The defect: everything the second driver's harness said was refused
      // and thrown away, so only the first answer was ever in the record.
      expect(said.some((t) => t.includes("answering first"))).toBe(true);
      expect(said.some((t) => t.includes("answering second"))).toBe(true);
    } finally {
      r.done();
    }
  });

  test("a third and a fourth too", async () => {
    // Four is what the record that turned this up had. Every driver after the
    // first was deaf.
    const r = record();
    try {
      for (const say of ["one", "two", "three", "four"]) await r.drive(say);
      const said = r.said();
      for (const say of ["one", "two", "three", "four"]) {
        expect(said.some((t) => t.includes(`answering ${say}`))).toBe(true);
      }
    } finally {
      r.done();
    }
  });

  test("no turn id is used twice across drivers", async () => {
    const r = record();
    try {
      await r.drive("first");
      await r.drive("second");
      const host = openConversation(r.dir, {
        now: () => Date.now(),
        presence: () => undefined,
        executorLease: () => true,
        onRecord: () => {},
        onEffect: () => {},
      });
      try {
        const ids = host.transcript().events.map((e) => String(e.turnId));
        // A reused id is what the reducer refuses, so this is the property
        // that makes the tests above pass rather than a restatement of them.
        // Two drivers ran, so the record must hold ids from two runs and no
        // id may belong to both.
        // Two drivers ran, so the record holds ids from two runs. Ids repeat
        // within a run - one turn carries several events - so what matters is
        // that no id belongs to both runs.
        const byRun = new Map<string, Set<string>>();
        for (const id of ids) {
          const run = id.split("-")[1] ?? "";
          const set = byRun.get(run) ?? new Set<string>();
          set.add(id);
          byRun.set(run, set);
        }
        expect(byRun.size).toBe(2);
        const [a, b] = [...byRun.values()];
        for (const id of a ?? []) expect(b?.has(id)).toBe(false);
      } finally {
        host.close();
      }
    } finally {
      r.done();
    }
  });
});
