/**
 * Files on a note (RFC-11).
 *
 * The requirement that carries the most weight is forward compatibility. A
 * batch is stored - it rides in the input text, which is in the log forever -
 * so a batch written by a newer build MUST still decode in an older one,
 * losing only the field it does not know. That is the opposite of RFC-08's
 * patch body, which refuses unknown fields on purpose because it is never
 * stored.
 */
import { describe, expect, test } from "bun:test";
import {
  type AnnotationBatch,
  detectAnnotationBatch,
  encodeAnnotationBatch,
  filesOf,
} from "../../src/protocol/annotations.js";

const HASH = "a".repeat(64);

const spot = {
  id: "e1",
  snippet: "the paragraph",
  author: "agent" as const,
};

const batch = (files?: unknown): AnnotationBatch =>
  ({
    artifactId: "doc",
    version: 3,
    notes: [{ note: "this is wrong", spots: [spot], ...(files === undefined ? {} : { files }) }],
  }) as AnnotationBatch;

const roundTrip = (b: AnnotationBatch): AnnotationBatch => {
  const found = detectAnnotationBatch(encodeAnnotationBatch(b));
  if (found === null || "malformed" in found) throw new Error("did not decode");
  return found;
};

describe("a file on a note", () => {
  test("survives encoding and decoding", () => {
    const f = { hash: HASH, bytes: 12, contentType: "image/png", name: "shot.png", path: "/t/x" };
    const out = roundTrip(batch([f]));
    expect(filesOf(out.notes[0] as never)).toEqual([f]);
  });

  test("a file with no path is valid — its contents were inlined", () => {
    const f = { hash: HASH, bytes: 4, contentType: "text/plain", name: "a.txt" };
    expect(filesOf(roundTrip(batch([f])).notes[0] as never).length).toBe(1);
  });

  test("several files on one note", () => {
    const files = [
      { hash: HASH, bytes: 1, contentType: "image/png", name: "a.png" },
      { hash: "b".repeat(64), bytes: 2, contentType: "image/png", name: "b.png" },
    ];
    expect(filesOf(roundTrip(batch(files)).notes[0] as never).length).toBe(2);
  });

  test("a note without files has none", () => {
    expect(filesOf(roundTrip(batch()).notes[0] as never)).toEqual([]);
  });
});

describe("a batch stays readable", () => {
  test("a newer build's unknown field is ignored, and the batch decodes", () => {
    // This is the requirement, written as the test. A batch is in the log
    // forever, so an older build must not choke on a field it never heard of.
    const withFuture = JSON.stringify({
      artifactId: "doc",
      version: 3,
      notes: [{ note: "hello", spots: [spot], somethingFromLater: { deeply: ["nested"] } }],
      alsoFromLater: 42,
    });
    const found = detectAnnotationBatch(`\`\`\`lucid-annotations\n${withFuture}\n\`\`\``);
    expect(found).not.toBeNull();
    expect(found && "malformed" in found).toBe(false);
    expect((found as AnnotationBatch).notes[0]?.note).toBe("hello");
  });

  test("a malformed files field is dropped and the note survives", () => {
    // Losing a file reference leaves a note that still says what it said.
    // Failing the note loses what the person wrote.
    for (const bad of ["not an array", 7, [{ hash: "short" }], [null], [{}]]) {
      const out = roundTrip(batch(bad));
      expect(out.notes[0]?.note).toBe("this is wrong");
      expect(filesOf(out.notes[0] as never)).toEqual([]);
    }
  });

  test("one bad file among good ones drops only the bad one", () => {
    const good = { hash: HASH, bytes: 1, contentType: "image/png", name: "a.png" };
    const out = roundTrip(batch([good, { hash: "nope" }]));
    expect(filesOf(out.notes[0] as never)).toEqual([good]);
  });

  test("a hash that is not a hash is not a file", () => {
    // The hash names a blob. Anything else would be a name that could be
    // used as a path, which is the thing the blob store refuses.
    const out = roundTrip(batch([{ hash: "../secret", bytes: 1, contentType: "t", name: "x" }]));
    expect(filesOf(out.notes[0] as never)).toEqual([]);
  });
});

describe("the preamble teaches it", () => {
  test("it mentions files and does not promise the agent can read one", async () => {
    const { ANNOTATION_PREAMBLE } = await import("../../src/protocol/annotations.js");
    expect(ANNOTATION_PREAMBLE).toContain("files");
    expect(ANNOTATION_PREAMBLE).toContain("path");
    // Naming a file is not delivering it.
    expect(ANNOTATION_PREAMBLE).toContain("if you are able");
  });
});
