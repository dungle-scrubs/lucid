import { describe, expect, test } from "bun:test";
import { decodeFrame, FRAME_KINDS, type Frame } from "../../src/protocol/frames.js";

const cid = "conv-1";

describe("frame codecs (M4.1)", () => {
  test("every protocol frame kind round-trips through the codec", () => {
    const frames: Frame[] = [
      { kind: "attach", conversationId: cid, secret: "s3cret", path: "interactive" },
      { kind: "attach-ok", conversationId: cid, epoch: 3, replayFrom: 17 },
      { kind: "event", conversationId: cid, epoch: 3, n: 1, event: { kind: "token", text: "x" } },
      { kind: "event-ack", conversationId: cid, seq: 42 },
      { kind: "input", conversationId: cid, epoch: 3, id: "in-1", text: "hello" },
      { kind: "disposition", conversationId: cid, inputId: "in-1", state: "queued" },
      { kind: "ack", conversationId: cid, seq: 42 },
      { kind: "heartbeat", conversationId: cid, epoch: 3 },
      { kind: "detach", conversationId: cid, epoch: 3 },
      { kind: "refused", conversationId: cid, issue: "stale-epoch" },
      { kind: "control", conversationId: cid, epoch: 3, op: "end" },
      { kind: "lease", conversationId: cid, epoch: 3, ttlMs: 5000 },
      { kind: "credit", conversationId: cid, tokens: 32 },
    ];
    // The declared kind list and the exercised list stay in lockstep.
    expect(frames.map((f) => f.kind).sort()).toEqual([...FRAME_KINDS].sort());
    for (const frame of frames) {
      const decoded = decodeFrame(frame);
      expect(decoded.verdict, `kind ${String(frame.kind)}`).toBe("ok");
      if (decoded.verdict === "ok") expect(decoded.frame).toEqual(frame);
    }
  });

  test("an unknown kind is refused with a named issue, not guessed at", () => {
    const decoded = decodeFrame({ kind: "teleport", conversationId: cid });
    expect(decoded).toEqual({ verdict: "refused", issue: "unknown-kind" });
  });

  test("malformed frames refuse with a named issue - never half-applied", () => {
    for (const [raw, issue] of [
      [{ kind: "attach", conversationId: cid }, "missing-field"], // no secret/path
      [{ kind: "event", conversationId: cid, epoch: "three", n: 1, event: {} }, "wrong-type"],
      [{ kind: "input", conversationId: cid, epoch: 1, id: "", text: "x" }, "missing-field"],
      [{ kind: "disposition", conversationId: cid, inputId: "i", state: "vanished" }, "wrong-type"],
      [{ kind: "control", conversationId: cid, epoch: 1, op: "self-destruct" }, "wrong-type"],
      ["not even an object", "not-a-frame"],
      [null, "not-a-frame"],
      [{ conversationId: cid }, "unknown-kind"],
    ] as const) {
      const decoded = decodeFrame(raw);
      expect(decoded.verdict, JSON.stringify(raw)).toBe("refused");
      if (decoded.verdict === "refused") expect(decoded.issue).toBe(issue);
    }
  });

  test("negative or non-integer sequence fields are refused", () => {
    expect(decodeFrame({ kind: "ack", conversationId: cid, seq: -1 }).verdict).toBe("refused");
    expect(decodeFrame({ kind: "ack", conversationId: cid, seq: 1.5 }).verdict).toBe("refused");
    expect(decodeFrame({ kind: "credit", conversationId: cid, tokens: -5 }).verdict).toBe(
      "refused",
    );
  });
});
