import { describe, expect, test } from "bun:test";
import { isQueueSend } from "../../src/server/client/hotkeys.js";
import { instrumentArtifact } from "../../src/server/client/instrument.js";

describe("recognising the send key", () => {
  const enter = (over: Record<string, unknown> = {}) => ({
    key: "Enter",
    altKey: false,
    metaKey: true,
    ...over,
  });

  test("command-Enter sends", () => {
    expect(isQueueSend(enter())).toBe(true);
  });

  test("control-Enter sends too, for a keyboard without a command key", () => {
    expect(isQueueSend(enter({ metaKey: false, ctrlKey: true }))).toBe(true);
  });

  test("Enter on its own is not it", () => {
    // It belongs to whatever is focused: a message, a newline in a note.
    expect(isQueueSend(enter({ metaKey: false }))).toBe(false);
  });

  test("another modifier means something else", () => {
    expect(isQueueSend(enter({ shiftKey: true }))).toBe(false);
    expect(isQueueSend(enter({ altKey: true }))).toBe(false);
  });

  test("what is queued is not asked here", () => {
    // Only the page knows whether a note box is open or the queue has
    // anything in it, and the frame has to ask this same question without
    // knowing either.
    expect(isQueueSend.length).toBe(1);
  });
});

describe("the frame forwards the send key too", () => {
  test("its guard matches this one", () => {
    const out = instrumentArtifact("<!doctype html><html><body><p>a</p></body></html>", "d", 1);
    expect(out).toContain(
      'if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)',
    );
    expect(out).toContain('hotkey: "send-queue"');
  });
});
