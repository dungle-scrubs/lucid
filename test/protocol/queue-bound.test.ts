/**
 * How many notes one queue may hold.
 *
 * A queue had no bound, and it goes as a single input, so one queue growing
 * without end is one input growing without end.
 *
 * What this does NOT bound is stated as plainly as what it does, because
 * both are decisions and only one of them is obvious from the number.
 */
import { describe, expect, test } from "bun:test";
import {
  encodeAnnotationBatch,
  NOTE_QUEUE_MAX,
  queueAdmits,
} from "../../src/protocol/annotations.js";
import { INPUT_QUEUE_MAX } from "../../src/protocol/events.js";

const note = (n: number) => ({
  note: `note ${n}`,
  spots: [{ id: `e${n}`, snippet: "somewhere", author: "agent" }],
});

describe("one queue is bounded", () => {
  test("an empty queue admits a note", () => {
    expect(queueAdmits(0).ok).toBe(true);
  });

  test("the last place in the queue is still a place", () => {
    // Off by one here means the bound is 19 or 21, and nothing else would
    // notice.
    expect(queueAdmits(NOTE_QUEUE_MAX - 1).ok).toBe(true);
  });

  test("a full queue admits nothing", () => {
    expect(queueAdmits(NOTE_QUEUE_MAX).ok).toBe(false);
  });

  test("a queue somehow past the bound stays refused", () => {
    // A stored queue written by an older build has no bound in it.
    expect(queueAdmits(NOTE_QUEUE_MAX + 50).ok).toBe(false);
  });

  test("the refusal says why, and says what to do about it", () => {
    const said = queueAdmits(NOTE_QUEUE_MAX);
    expect(said.ok).toBe(false);
    if (said.ok) throw new Error("expected a refusal");
    expect(said.why).toContain(String(NOTE_QUEUE_MAX));
    // A refusal that does not name the way out leaves a person stuck with a
    // full queue and a disabled button.
    expect(said.why.toLowerCase()).toContain("send");
  });

  test("the bound is 20", () => {
    // Pinned deliberately. It is a policy number from RFC-07 R10, not one
    // derived from anything, so a change to it is a decision and should
    // fail here rather than pass quietly.
    expect(NOTE_QUEUE_MAX).toBe(20);
  });
});

describe("what the bound is not", () => {
  test("it is not the in-flight input bound", () => {
    // INPUT_QUEUE_MAX counts inputs delivered and not yet finished. An
    // unsent queue counts zero there however full it is, and a sent batch
    // counts one however many notes it carries. Reading one as the other is
    // the mistake this test exists to catch.
    expect(NOTE_QUEUE_MAX).not.toBe(INPUT_QUEUE_MAX);
  });

  test("a full queue is still one input", () => {
    const body = encodeAnnotationBatch({
      artifactId: "doc",
      version: 3,
      notes: Array.from({ length: NOTE_QUEUE_MAX }, (_, i) => note(i)),
    });
    // One fence, one artifactId, one version: one input, whatever it holds.
    expect(body.match(/lucid-annotations/g)?.length).toBe(1);
    expect(body.match(/"artifactId"/g)?.length).toBe(1);
  });

  test("it says nothing about how many queues exist", () => {
    // A queue belongs to an artifact and a version. Moving between versions
    // leaves one per version, each bounded, and every one survives - that is
    // what makes notes come back when you return to a version. The number of
    // queues is deliberately not bounded here.
    const perVersion = [3, 4, 5].map(() => queueAdmits(NOTE_QUEUE_MAX - 1));
    for (const one of perVersion) expect(one.ok).toBe(true);
  });
});
