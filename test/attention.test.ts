import { describe, expect, test } from "bun:test";
import { attentionOf } from "../src/core/attention.ts";
import type { LogEvent } from "../src/core/events.ts";
import { foldLog } from "../src/core/fold.ts";

/**
 * The attention fold (plan 03, M1.1). `attentionOf` reduces a session's folded
 * state to the four signals the grouped tab strip needs - open questions, the
 * working window, approval, and the high-water seq. The read and the cache
 * underneath it are `sessionState`'s (test/session-state.test.ts).
 */

const ev = (e: Partial<LogEvent> & { t: LogEvent["t"]; seq: number }): LogEvent =>
  ({ at: "2026-01-01T00:00:00Z", ...e }) as LogEvent;

const opened = ev({ t: "session_opened", seq: 1, artifact: "plan.html" } as never);

const attention = (events: readonly LogEvent[]) => attentionOf(foldLog(events));

describe("attentionOf: the four signals", () => {
  test("openQuestions counts unanswered questions, not answered or skipped ones", () => {
    const a = attention([
      opened,
      ev({ t: "question", seq: 2, id: "q1", text: "where?" } as never),
      ev({ t: "question", seq: 3, id: "q2", text: "when?" } as never),
      ev({ t: "question_answered", seq: 4, questionId: "q2", answer: "now" } as never),
    ]);
    expect(a.openQuestions).toBe(1); // q1 open, q2 answered
  });

  test("working is true while the agent-work window is open, false once output lands", () => {
    const acked = attention([
      opened,
      ev({ t: "annotation", seq: 2, id: "n1", target: {}, note: "fix" } as never),
      ev({ t: "agent_ack", seq: 3 } as never),
    ]);
    expect(acked.working).toBe(true);
    const produced = attention([
      opened,
      ev({ t: "agent_ack", seq: 3 } as never),
      ev({ t: "version", seq: 4, version: 2, hash: "h", path: "versions/s1/v2.html" } as never),
    ]);
    expect(produced.working).toBe(false); // the version closed the window
  });

  test("resolved reflects the review approval toggle", () => {
    expect(attention([opened]).resolved).toBe(false);
    const approved = attention([opened, ev({ t: "review_resolved", seq: 2 } as never)]);
    expect(approved.resolved).toBe(true);
  });

  test("lastEventSeq is the monotonic high-water mark", () => {
    expect(attention([opened]).lastEventSeq).toBe(1);
    expect(attention([opened, ev({ t: "agent_ack", seq: 7 } as never)]).lastEventSeq).toBe(7);
  });
});
