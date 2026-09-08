/**
 * Pending notes keep the place they were written in.
 *
 * Write a note, say something to the agent, write another: all three read
 * back in the order you did them. That order is the whole reason a note
 * belongs in the timeline rather than in a list beside it.
 */
import { describe, expect, test } from "bun:test";
import { type Msg, type PendingNote, weaveNotes } from "../../src/server/client/timeline.js";

test("a refreshed shorter transcript keeps a later queued note visible at its end", () => {
  const pending: PendingNote = { note: "Keep this queued note", at: 8, spots: [] };
  expect(weaveNotes([], [pending]).map((m) => m.text)).toEqual([pending.note]);
});

test("saved versions do not move a later queued note before an earlier message", () => {
  const messages: Msg[] = [0, 1, 2, 3].map((seq) => ({
    id: `m${seq}`,
    seq,
    role: "assistant",
    text: `Message ${seq}`,
  }));
  const notes: PendingNote[] = [{ note: "Written last", at: 4, spots: [] }];
  const saves = [
    { after: 0, line: { id: "save-1", role: "user" as const, text: "Saved v1", note: true } },
  ];
  expect(weaveNotes(messages, notes, saves).map((m) => m.text)).toEqual([
    "Message 0",
    "Saved v1",
    "Message 1",
    "Message 2",
    "Message 3",
    "Written last",
  ]);
});

const msg = (id: string, text: string): Msg => ({ id, role: "user", text });
const note = (text: string, at: number): PendingNote => ({
  note: text,
  spots: [{ id: "e1", snippet: "somewhere", author: "agent" }],
  at,
});

const shape = (out: readonly Msg[]): string[] =>
  out.map((m) => (m.pendingNote === undefined ? `msg:${m.text}` : `note:${m.text}`));

describe("weaving pending notes into the conversation", () => {
  test("with no notes the messages are unchanged", () => {
    const messages = [msg("a", "one"), msg("b", "two")];
    expect(shape(weaveNotes(messages, []))).toEqual(["msg:one", "msg:two"]);
  });

  test("a note written between two messages stays between them", () => {
    // The case that matters: write a note, talk to the agent, and the note
    // does not jump to the end.
    const messages = [msg("a", "one"), msg("b", "two")];
    expect(shape(weaveNotes(messages, [note("mid", 1)]))).toEqual([
      "msg:one",
      "note:mid",
      "msg:two",
    ]);
  });

  test("several notes and messages all keep their order", () => {
    const messages = [msg("a", "one"), msg("b", "two"), msg("c", "three")];
    const notes = [note("first", 1), note("second", 3)];
    expect(shape(weaveNotes(messages, notes))).toEqual([
      "msg:one",
      "note:first",
      "msg:two",
      "msg:three",
      "note:second",
    ]);
  });

  test("two notes written back to back stay adjacent and in order", () => {
    const messages = [msg("a", "one")];
    expect(shape(weaveNotes(messages, [note("x", 1), note("y", 1)]))).toEqual([
      "msg:one",
      "note:x",
      "note:y",
    ]);
  });

  test("a note written before anything was said comes first", () => {
    expect(shape(weaveNotes([msg("a", "one")], [note("early", 0)]))).toEqual([
      "note:early",
      "msg:one",
    ]);
  });

  test("a note written after the last message is last", () => {
    const messages = [msg("a", "one"), msg("b", "two")];
    expect(shape(weaveNotes(messages, [note("late", 2)]))).toEqual([
      "msg:one",
      "msg:two",
      "note:late",
    ]);
  });

  test("notes handed over out of order are still placed in order", () => {
    const messages = [msg("a", "one"), msg("b", "two")];
    expect(shape(weaveNotes(messages, [note("second", 2), note("first", 1)]))).toEqual([
      "msg:one",
      "note:first",
      "msg:two",
      "note:second",
    ]);
  });

  test("every note survives the weave, and no message is lost or repeated", () => {
    const messages = [msg("a", "one"), msg("b", "two"), msg("c", "three")];
    const notes = [note("n1", 0), note("n2", 2), note("n3", 3)];
    const out = weaveNotes(messages, notes);
    expect(out.filter((m) => m.pendingNote !== undefined).length).toBe(3);
    expect(out.filter((m) => m.pendingNote === undefined).length).toBe(3);
    expect(new Set(out.map((m) => m.id)).size).toBe(out.length);
  });

  test("the messages array is not mutated", () => {
    const messages = [msg("a", "one")];
    weaveNotes(messages, [note("x", 0)]);
    expect(messages.length).toBe(1);
  });
});
