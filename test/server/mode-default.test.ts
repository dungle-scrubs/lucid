/**
 * Which mode a document opens in, in both places that decide it.
 *
 * Two things hold a default: the page's own state, and the frame's, because
 * the frame paints before the page's first mode message reaches it. They have
 * to agree or the document is editable for that moment - long enough for a
 * click to tick a box the person meant to select.
 *
 * The page's default is not reachable from a test without rendering React, so
 * this reads the source for it. That is worth doing anyway: the whole point
 * is that two separate declarations say the same thing, and a test that
 * checked only one would pass while they drifted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { instrumentArtifact } from "../../src/server/client/instrument.js";

const DOC = "<!doctype html><html><body><p>text</p></body></html>";
const appSource = readFileSync(join(import.meta.dir, "../../src/server/client/app.tsx"), "utf8");

describe("a document opens in mark-up mode", () => {
  test("the frame starts there", () => {
    expect(instrumentArtifact(DOC, "doc-1", 1)).toContain('var mode = "markup"');
  });

  test("the page starts there too", () => {
    expect(appSource).toContain('React.useState<"use" | "markup">("markup")');
  });

  test("neither declares the other default", () => {
    // The failure this catches: one changed and the other did not, so the
    // frame renders editable until the page corrects it a moment later.
    expect(instrumentArtifact(DOC, "doc-1", 1)).not.toContain('var mode = "use"');
    expect(appSource).not.toContain('React.useState<"use" | "markup">("use")');
  });

  test("use mode is still reachable, and still means what it meant", () => {
    // Changing the default must not remove the mode. Everything that made a
    // click operate a control rather than select an element is still keyed on
    // the same two names.
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out).toContain('m.mode === "use"');
    expect(out).toContain('mode === "use"');
  });
});
