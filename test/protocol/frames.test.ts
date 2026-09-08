import { describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  type Frame,
  parseFrame,
  REFUSAL_ISSUES,
} from "../../src/protocol/frames.js";

const cid = "conv-1";

const SAMPLES: Frame[] = [
  { kind: "attach", conversationId: cid, profile: "interactive", secret: "s3cret", version: 1 },
  { kind: "event", epoch: 3, n: 1, turnId: "t-1", event: { kind: "token", text: "x" } },
  { kind: "ack", epoch: 3, covers: 42 },
  { kind: "disposition", epoch: 3, inputId: "in-1", outcome: "queued" },
  { kind: "heartbeat", epoch: 3 },
  { kind: "detach", epoch: 3, reason: "yield" },
  {
    kind: "attach-ok",
    epoch: 3,
    lease: { expires: 5000, renewEvery: 1000 },
    replayFrom: 17,
    version: 1,
  },
  { kind: "refused", issue: "stale-epoch" },
  { kind: "event-ack", epoch: 3, n: 1 },
  { kind: "input", seq: 42, id: "in-1", text: "hello", mode: "queue" },
  { kind: "control", seq: 43, action: "end" },
  { kind: "lease", epoch: 3, expires: 9000 },
  { kind: "credit", epoch: 3, tokens: 32 },
];

describe("frame codecs (M4.1)", () => {
  test("every declared kind has a sample, and each round-trips through encode/parse", () => {
    expect(SAMPLES.map((f) => f.kind).sort()).toEqual([...FRAME_KINDS].sort());
    for (const frame of SAMPLES) {
      const decoded = parseFrame(encodeFrame(frame));
      expect(decoded.verdict, `kind ${frame.kind}`).toBe("ok");
      if (decoded.verdict === "ok") expect(decoded.frame).toEqual(frame);
    }
  });

  test("the decoded frame is CONSTRUCTED, not the input by reference", () => {
    const input = { kind: "ack", epoch: 3, covers: 42 };
    const decoded = decodeFrame(input);
    expect(decoded.verdict).toBe("ok");
    if (decoded.verdict === "ok") expect(decoded.frame).not.toBe(input);
  });

  test("extra fields never ride into the typed frame", () => {
    const decoded = decodeFrame({ kind: "ack", epoch: 3, covers: 1, secret: "leak", evil: true });
    expect(decoded.verdict).toBe("ok");
    if (decoded.verdict === "ok") {
      expect(Object.keys(decoded.frame).sort()).toEqual(["covers", "epoch", "kind"]);
    }
  });

  test("prototype-carried fields do not validate a frame that decodes to nothing", () => {
    const decoded = decodeFrame(Object.create({ kind: "ack", epoch: 3, covers: 5 }));
    expect(decoded.verdict).toBe("refused");
  });

  test("a JSON __proto__ key cannot pollute a copy of the decoded frame", () => {
    const decoded = parseFrame('{"kind":"ack","epoch":3,"covers":1,"__proto__":{"polluted":1}}');
    expect(decoded.verdict).toBe("ok");
    if (decoded.verdict === "ok") {
      const copy = Object.assign({}, decoded.frame) as Record<string, unknown>;
      expect(copy.polluted).toBeUndefined();
    }
  });

  test("unknown kind and non-frames refuse with distinct named issues", () => {
    expect(decodeFrame({ kind: "teleport", conversationId: cid })).toEqual({
      verdict: "refused",
      issue: "unknown-kind",
    });
    expect(decodeFrame({ conversationId: cid }).verdict).toBe("refused");
    expect(decodeFrame("nope")).toEqual({ verdict: "refused", issue: "not-a-frame" });
    expect(decodeFrame(null)).toEqual({ verdict: "refused", issue: "not-a-frame" });
    expect(decodeFrame([1, 2])).toEqual({ verdict: "refused", issue: "not-a-frame" });
    expect(parseFrame("{not json")).toEqual({ verdict: "refused", issue: "not-json" });
  });

  test("the codec keeps its own input-mode check: a value outside INPUT_MODES refuses wrong-type at the boundary", () => {
    // A truly unknown mode is refused before the reducer ever sees it; the
    // reducer carries the same check for the fold path (RFC-05 B4), and this
    // one is the early failure that keeps most unknown modes from reaching it
    // at all. "answer" is now a known mode (RFC-05 T45) and needs its own
    // turnId rule - that is tested below, not here.
    const input = SAMPLES.find((f) => f.kind === "input");
    if (input === undefined) throw new Error("input sample is missing");
    expect(decodeFrame({ ...input, mode: "yolo" as never })).toEqual({
      verdict: "refused",
      issue: "wrong-type",
    });
  });

  test("each required field, deleted in turn, refuses with missing-field", () => {
    for (const sample of SAMPLES) {
      for (const field of Object.keys(sample)) {
        if (field === "kind") continue;
        const partial: Record<string, unknown> = { ...sample };
        delete partial[field];
        const decoded = decodeFrame(partial);
        expect(decoded.verdict, `${sample.kind} without ${field}`).toBe("refused");
        if (decoded.verdict === "refused") {
          expect(["missing-field", "wrong-type"]).toContain(decoded.issue);
        }
      }
    }
  });

  test("epoch is required on every post-attach frame (fencing token)", () => {
    const postAttach = SAMPLES.filter((f) => "epoch" in f);
    expect(postAttach.length).toBeGreaterThan(6);
    for (const frame of postAttach) {
      const withoutEpoch: Record<string, unknown> = { ...frame };
      delete withoutEpoch.epoch;
      expect(decodeFrame(withoutEpoch).verdict, `${frame.kind} without epoch`).toBe("refused");
    }
  });

  test("non-safe-integer sequence fields are refused (monotonicity guard)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 1.5, -1, 1e308]) {
      expect(decodeFrame({ kind: "ack", epoch: 3, covers: bad }).verdict, `covers=${bad}`).toBe(
        "refused",
      );
      expect(decodeFrame({ kind: "event", epoch: bad, n: 1, turnId: "t", event: {} }).verdict).toBe(
        "refused",
      );
    }
  });

  test("control characters and over-long strings are refused", () => {
    expect(decodeFrame({ kind: "refused", issue: "line1\nline2" }).verdict).toBe("refused");
    expect(
      decodeFrame({
        kind: "attach",
        conversationId: "c\0x",
        profile: "interactive",
        secret: "s",
        version: 1,
      }).verdict,
    ).toBe("refused");
    expect(decodeFrame({ kind: "refused", issue: "x".repeat(200) }).verdict).toBe("refused");
  });

  test("a wrong-typed conversationId is wrong-type, not missing-field", () => {
    expect(
      decodeFrame({
        kind: "attach",
        conversationId: 5,
        profile: "interactive",
        secret: "s",
        version: 1,
      }),
    ).toEqual({ verdict: "refused", issue: "wrong-type" });
  });

  test("enum fields refuse out-of-vocabulary values", () => {
    expect(decodeFrame({ kind: "control", seq: 1, action: "self-destruct" }).verdict).toBe(
      "refused",
    );
    expect(
      decodeFrame({ kind: "disposition", epoch: 1, inputId: "i", outcome: "vanished" }).verdict,
    ).toBe("refused");
    expect(
      decodeFrame({
        kind: "attach",
        conversationId: cid,
        profile: "telepathic",
        secret: "s",
        version: 1,
      }).verdict,
    ).toBe("refused");
  });

  test("a non-serializable or non-object event payload is refused", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(decodeFrame({ kind: "event", epoch: 1, n: 1, turnId: "t", event: cyclic }).verdict).toBe(
      "refused",
    );
    expect(decodeFrame({ kind: "event", epoch: 1, n: 1, turnId: "t", event: [1, 2] }).verdict).toBe(
      "refused",
    );
  });

  test("optional fields present-but-wrong are refused; absent is fine", () => {
    expect(
      decodeFrame({
        kind: "attach",
        conversationId: cid,
        profile: "interactive",
        secret: "s",
        version: 1,
        resumeFrom: -1,
      }).verdict,
    ).toBe("refused");
    const ok = decodeFrame({
      kind: "input",
      seq: 1,
      id: "i",
      text: "",
      mode: "steer",
      turnId: "t-9",
    });
    expect(ok.verdict).toBe("ok");
  });

  test("every refusal issue rides a refused frame, input-queue-full included, and an unknown issue still fails closed", () => {
    // REFUSAL_ISSUES is wire vocabulary: a `refused` frame carries the
    // issue, so the codec must accept each one the reducer can raise -
    // input-queue-full (RFC-04) is why this test exists - while anything
    // outside the list refuses wrong-type. That fail-closed is the whole
    // compatibility story for a reader one issue behind: it refuses a
    // frame it cannot interpret rather than guessing at it.
    expect(REFUSAL_ISSUES).toContain("input-queue-full");
    for (const issue of REFUSAL_ISSUES) {
      const decoded = parseFrame(encodeFrame({ kind: "refused", issue }));
      expect(decoded.verdict, issue).toBe("ok");
      if (decoded.verdict === "ok") expect(decoded.frame).toEqual({ kind: "refused", issue });
    }
    expect(decodeFrame({ kind: "refused", issue: "not-an-issue" })).toEqual({
      verdict: "refused",
      issue: "wrong-type",
    });
  });
});
