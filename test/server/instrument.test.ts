/**
 * What lucid adds to a document, and what it must not add it to.
 *
 * The behaviour of the injected script is proven in a browser — it needs a
 * DOM, a pointer, and a real `isTrusted` to mean anything. What is proven
 * here is the part that is decidable from the bytes: that instrumentation
 * is added to the copy the frame renders and to nothing else, and that the
 * id shape the parent validates against is the one the script assigns.
 */
import { describe, expect, test } from "bun:test";
import {
  ELEMENT_ATTR,
  ELEMENT_ID,
  FRAME_MESSAGE_SOURCE,
  instrumentArtifact,
} from "../../src/server/client/instrument.js";

const DOC = "<!doctype html><html><body><h1>title</h1><p>text</p></body></html>";

describe("instrumentation is added to the render, not to the document", () => {
  test("the document's own bytes survive it unchanged", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out).toContain("<h1>title</h1><p>text</p>");
    expect(out.indexOf("<h1>title</h1>")).toBeLessThan(out.indexOf("data-lucid"));
  });

  test("it goes inside body, so the document's own scripts have already run", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out.indexOf("data-lucid")).toBeLessThan(out.indexOf("</body>"));
    expect(out.endsWith("</body></html>")).toBe(true);
  });

  test("a document with no body still gets it", () => {
    const out = instrumentArtifact("<h1>fragment</h1>", "doc-1", 1);
    expect(out).toContain("<h1>fragment</h1>");
    expect(out).toContain("data-lucid");
  });

  test("the frame is told which document and version it is rendering", () => {
    const out = instrumentArtifact(DOC, "doc-7", 3);
    // The parent refuses a message naming a different one, so the frame has
    // to carry both.
    expect(out).toContain('"doc-7"');
    expect(out).toContain(FRAME_MESSAGE_SOURCE);
    expect(out).toMatch(/VERSION = 3/);
  });

  test("instrumenting is a function of the bytes, not a mutation of them", () => {
    const before = DOC;
    instrumentArtifact(DOC, "doc-1", 1);
    expect(before).toBe(DOC);
    expect(instrumentArtifact(DOC, "doc-1", 1)).toBe(instrumentArtifact(DOC, "doc-1", 1));
  });
});

describe("the identity is lucid's, not the document's", () => {
  test("the script assigns the attribute rather than reading the document's ids", () => {
    const out = instrumentArtifact('<body><p id="theirs">x</p></body>', "doc-1", 1);
    // The agent's own id is left alone and is not used as an address.
    expect(out).toContain('id="theirs"');
    expect(out).toContain(`setAttribute(ATTR`);
    expect(out).toContain(JSON.stringify(ELEMENT_ATTR));
  });

  test("the id shape the parent validates against matches what the script assigns", () => {
    // The script assigns "e" + a document-order counter.
    expect(ELEMENT_ID.test("e1")).toBe(true);
    expect(ELEMENT_ID.test("e42")).toBe(true);
    expect(ELEMENT_ID.test("theirs")).toBe(false);
    expect(ELEMENT_ID.test("e1; drop")).toBe(false);
    expect(ELEMENT_ID.test("")).toBe(false);
  });
});

describe("the document's own behaviour is left alone", () => {
  test("nothing is cancelled and nothing is stopped", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out).not.toContain("preventDefault");
    expect(out).not.toContain("stopPropagation");
    expect(out).not.toContain("stopImmediatePropagation");
  });

  test("only a real person's events count", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // Every listener the script installs guards on isTrusted, so a document
    // dispatching its own click is doing its own work and lucid does not
    // read it as a selection.
    const listeners = out.match(/addEventListener\(/g) ?? [];
    const guards = out.match(/if \(!e\.isTrusted\) return;/g) ?? [];
    expect(listeners.length).toBeGreaterThan(0);
    expect(guards.length).toBe(listeners.length);
  });
});
