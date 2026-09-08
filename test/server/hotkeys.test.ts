/**
 * The one hotkey, and the one place it stands down.
 *
 * Alt-Backspace flips between using the document and marking it up. It has
 * to reach the toggle from inside the frame too, so both sides ask the same
 * question — and both have to answer it the same way, or the key works in
 * half the window.
 */
import { describe, expect, test } from "bun:test";
import { isModeToggle, isQueueSend } from "../../src/server/client/hotkeys.js";
import { instrumentArtifact } from "../../src/server/client/instrument.js";

const key = (over: Record<string, unknown> = {}) => ({
  key: "Backspace",
  altKey: true,
  ...over,
});

describe("recognising the mode toggle", () => {
  test("alt-backspace is the toggle", () => {
    expect(isModeToggle(key())).toBe(true);
  });

  test("backspace on its own is not", () => {
    // Otherwise deleting a character would flip the document out from under
    // whoever was typing.
    expect(isModeToggle(key({ altKey: false }))).toBe(false);
  });

  test("another key with alt held is not", () => {
    expect(isModeToggle(key({ key: "Delete" }))).toBe(false);
    expect(isModeToggle(key({ key: "a" }))).toBe(false);
  });

  test("a second modifier means something else", () => {
    // cmd-alt-backspace and ctrl-alt-backspace belong to the browser and the
    // operating system, and shift-alt-backspace is not this.
    expect(isModeToggle(key({ metaKey: true }))).toBe(false);
    expect(isModeToggle(key({ ctrlKey: true }))).toBe(false);
    expect(isModeToggle(key({ shiftKey: true }))).toBe(false);
  });
});

describe("the frame asks the same question", () => {
  test("its guard matches this one, clause for clause", () => {
    // The frame's copy is hand-written JavaScript inside an injected
    // string: it cannot import this module, so the two can drift and only
    // half the window would stop responding to the key.
    const out = instrumentArtifact("<!doctype html><html><body><p>a</p></body></html>", "d", 1);
    expect(out).toContain('if (!e.altKey || e.key !== "Backspace") return;');
    expect(out).toContain("if (e.ctrlKey || e.metaKey || e.shiftKey) return;");
  });

  test("neither side looks at what was focused", () => {
    // It fires wherever it is pressed. An exception on one side only would
    // be exactly the drift above, in the form hardest to notice.
    const out = instrumentArtifact("<!doctype html><html><body><p>a</p></body></html>", "d", 1);
    const guard = out.slice(out.indexOf("if (!e.altKey"), out.indexOf("preventDefault"));
    expect(guard).not.toContain("target");
    expect(guard).not.toContain("closest");
    expect(isModeToggle.length).toBe(1);
  });
});

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

  test("it is not the mode toggle, and the toggle is not it", () => {
    // They share one listener. Either one matching the other's press would
    // fire both.
    expect(isModeToggle(enter())).toBe(false);
    expect(isQueueSend({ key: "Backspace", altKey: true })).toBe(false);
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
