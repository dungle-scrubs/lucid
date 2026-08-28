/**
 * The seam's placement (3e): where a lost note pointed, as a gap between
 * blocks in the version on screen.
 *
 * The documents are synthetic on purpose - no local record holds a note that
 * lost its passage to a removal - and say so: a hand-built pair of versions
 * where the middle paragraph is gone, and the selectors a note would carry
 * for it.
 */
import { describe, expect, test } from "bun:test";
import "../support/dom.js";
import type { SpotSelectors } from "../../src/server/client/anchor.js";
import { seamsForLost } from "../../src/server/client/seams.js";

const doc = (body: string): Document =>
  new DOMParser().parseFromString(`<!doctype html><html><body>${body}</body></html>`, "text/html");

/** The selectors a whole-element spot would have written against `body`. */
const cssFor = (d: Document, nth: number): string => {
  const p = d.body.querySelectorAll("p")[nth];
  return `body > p:nth-of-type(${nth + 1})`;
};

const selectors = (d: Document, nth: number): SpotSelectors => ({
  quote: { exact: p(d, nth).textContent ?? "", prefix: "", suffix: "" },
  position: { start: 0, end: 10 },
  css: cssFor(d, nth),
});

function p(d: Document, nth: number): Element {
  return d.body.querySelectorAll("p")[nth] as Element;
}

const OLD = `<p>Alpha stays.</p><p>Bravo is dropped.</p><p>Charlie stays.</p><p>Delta stays.</p>`;
const NEW = `<p>Alpha stays.</p><p>Charlie stays.</p><p>Delta stays.</p>`;

describe("seam placement (3e)", () => {
  const older = doc(OLD);
  const target = doc(NEW);

  test("a note anchored in a removed paragraph gets a seam before the next survivor", () => {
    const seams = seamsForLost(
      [{ fromVersion: 3, selectors: selectors(older, 1) }],
      new Map([[3, older]]),
      target,
      4,
    );
    expect(seams).toHaveLength(1);
    // Charlie is block 1 in the new document; the seam goes before it.
    expect(seams[0]?.before).toBe(1);
    expect(seams[0]?.label).toContain("1 note pointed here");
    expect(seams[0]?.label).toContain("gone from v4");
    expect(seams[0]?.version).toBe(3);
  });

  test("notes lost to a rewording get no seam - the passage is not gone", () => {
    // Bravo survives, reworded; the anchor failed but the words are there.
    const reworded = doc(`<p>Alpha stays.</p><p>Bravo stays, reworded entirely.</p>`);
    const next = doc(`<p>Alpha stays.</p><p>Bravo stays, rewritten again by the agent.</p>`);
    const seams = seamsForLost(
      [{ fromVersion: 3, selectors: selectors(reworded, 1) }],
      new Map([[3, reworded]]),
      next,
      4,
    );
    expect(seams).toHaveLength(0);
  });

  test("a removed tail puts the seam at the end", () => {
    const olderTail = doc(`<p>Alpha.</p><p>Omega is dropped.</p>`);
    const targetTail = doc(`<p>Alpha.</p>`);
    const seams = seamsForLost(
      [{ fromVersion: 2, selectors: selectors(olderTail, 1) }],
      new Map([[2, olderTail]]),
      targetTail,
      3,
    );
    expect(seams).toHaveLength(1);
    // Nothing survived after it, so the seam goes last: at the block count.
    expect(seams[0]?.before).toBe(1);
  });

  test("two notes into one gap share one seam and it counts them", () => {
    const seams = seamsForLost(
      [
        { fromVersion: 3, selectors: selectors(older, 1) },
        { fromVersion: 3, selectors: selectors(older, 1) },
      ],
      new Map([[3, older]]),
      target,
      4,
    );
    expect(seams).toHaveLength(1);
    expect(seams[0]?.label).toContain("2 notes pointed here");
  });

  test("the seam opens the earliest version its notes still read on", () => {
    const seams = seamsForLost(
      [
        { fromVersion: 5, selectors: selectors(older, 1) },
        { fromVersion: 3, selectors: selectors(older, 1) },
      ],
      new Map([
        [3, older],
        [5, older],
      ]),
      target,
      6,
    );
    expect(seams).toHaveLength(1);
    expect(seams[0]?.version).toBe(3);
  });

  test("a spot with no selectors, or a version whose bytes are missing, draws nothing", () => {
    expect(
      seamsForLost([{ fromVersion: 3, selectors: undefined }], new Map([[3, older]]), target, 4),
    ).toHaveLength(0);
    expect(
      seamsForLost([{ fromVersion: 9, selectors: selectors(older, 1) }], new Map(), target, 4),
    ).toHaveLength(0);
  });
});
