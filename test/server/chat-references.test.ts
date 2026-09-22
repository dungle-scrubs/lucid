/**
 * Agent chat references resolved against the version on screen.
 *
 * The case: the agent quoted exact words from the document and the browser
 * turns that quote into a link. A quote that matches resolves to the block
 * holding it; a quote from an older version, or words that appear nowhere,
 * resolves to null and renders as prose.
 */
import { describe, expect, test } from "bun:test";
import "../support/dom.js";
import {
  chatLinkTravels,
  resolveChatReferences,
  splitChatLabels,
} from "../../src/server/client/chat-references.js";

const DOC = `<!doctype html><html><body>
<h1>Field notes</h1>
<p>The upper catchment holds water longer than the open pasture.</p>
<h2>Next survey</h2>
<p>Keep the next survey focused on the stream edge.</p>
</body></html>`;

const refs = (
  version: number,
  refs: readonly { quote: string; label: string }[],
  artifactId = "doc-1",
) => [{ artifactId, version, refs }];

describe("chat references", () => {
  test("a quote from the version on screen resolves to its block", () => {
    const out = resolveChatReferences(
      DOC,
      3,
      refs(3, [{ quote: "Next survey", label: "Next survey section" }]),
      "doc-1",
    );
    expect(out.length).toBe(1);
    expect(out[0]?.elementId).not.toBeNull();
    expect(out[0]?.label).toBe("Next survey section");
  });

  test("a quote from an older version does not resolve", () => {
    const out = resolveChatReferences(
      DOC,
      4,
      refs(3, [{ quote: "Next survey", label: "Next survey section" }]),
      "doc-1",
    );
    expect(out).toEqual([]);
  });

  test("words that appear nowhere resolve to null and render as prose", () => {
    const out = resolveChatReferences(
      DOC,
      3,
      refs(3, [{ quote: "a paragraph that was never written", label: "Missing" }]),
      "doc-1",
    );
    expect(out.length).toBe(1);
    expect(out[0]?.elementId).toBeNull();
  });

  test("refs for another artifact are ignored", () => {
    const out = resolveChatReferences(
      DOC,
      3,
      refs(3, [{ quote: "Next survey", label: "Next survey section" }], "other-doc"),
      "doc-1",
    );
    expect(out).toEqual([]);
  });

  test("bracketed labels split into text and label parts with stable offsets", () => {
    expect(splitChatLabels("See the [Next survey section] today.")).toEqual([
      { kind: "text", text: "See the ", at: 0 },
      { kind: "label", label: "Next survey section", at: 8 },
      { kind: "text", text: " today.", at: 29 },
    ]);
  });

  test("an unmatched bracket stays text", () => {
    expect(splitChatLabels("no brackets here")).toEqual([
      { kind: "text", text: "no brackets here", at: 0 },
    ]);
    expect(splitChatLabels("a [bracket without end")).toEqual([
      { kind: "text", text: "a [bracket without end", at: 0 },
    ]);
  });

  test("a reworded passage still matches approximately", () => {
    const revised = DOC.replace("stream edge", "stream bank");
    const out = resolveChatReferences(
      revised,
      3,
      refs(3, [{ quote: "Keep the next survey focused on the stream edge.", label: "Survey" }]),
      "doc-1",
    );
    expect(out[0]?.elementId).not.toBeNull();
  });

  test("offsets map through the same text nodes the search uses", () => {
    // Whitespace between elements and text beside inline children belong
    // to `whole` but to no leaf block. Summing leaf textContent drifts;
    // walking text nodes does not.
    const mixed = "<body><p>prefix <b>x</b></p><p>target</p><p>padding</p></body>";
    const out = resolveChatReferences(
      mixed,
      1,
      refs(1, [{ quote: "target", label: "T" }]),
      "doc-1",
    );
    // Elements in order: P, B, P(target), P. The quote names the third.
    expect(out[0]).toMatchObject({ elementId: "e3", how: "exact" });
  });

  test("repeated words do not resolve verbatim", () => {
    const doubled = DOC.replace("open pasture.", "open pasture. Next survey.");
    const out = resolveChatReferences(
      doubled,
      3,
      refs(3, [{ quote: "Next survey", label: "Next survey section" }]),
      "doc-1",
    );
    // First occurrence is not picked silently: the verbatim layer refuses
    // ambiguity and the approximate layer must confirm or refuse on its own.
    const how = out[0]?.how;
    expect(out[0]?.elementId === null || how !== "exact").toBe(true);
  });
});

describe("chat link travel", () => {
  test("a click travels while following the newest version", () => {
    expect(chatLinkTravels(false)).toBe(true);
  });

  test("a click stays inert while an older version is pinned", () => {
    // The target was resolved against what is on screen. Jumping inside
    // a version it was not written against points at the wrong place
    // rather than at nothing, so the pinned page does not move and
    // nothing lights. Proven live: pinned v1 before/after shots match.
    expect(chatLinkTravels(true)).toBe(false);
  });
});
