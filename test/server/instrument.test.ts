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
  test("nothing is stopped, ever", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // Stopping propagation would hide the event from the document's own
    // listeners. Nothing lucid does needs that.
    expect(out).not.toContain("stopPropagation");
    expect(out).not.toContain("stopImmediatePropagation");
  });

  test("a click is cancelled only while marking up", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // In use mode the document behaves as the agent built it: a click ticks
    // the box under it and lucid does nothing. In mark-up mode a click
    // picks an element, and letting it also tick the box would make one
    // click do two things.
    // Two: the mousedown, which stops a control taking focus and drawing a
    // caret, and the click, which stops it being operated. Focus moves on
    // mousedown, so cancelling only the click was too late.
    // Which listener each cancel belongs to, read from the nearest
    // registration above it. Counting cancels on their own said nothing
    // about mouse events, which is what this is a rule about.
    const listener = (at: number): string => {
      const before = out.slice(0, at);
      const opened = before.lastIndexOf("addEventListener(");
      return /"([a-z]+)"/.exec(out.slice(opened, at))?.[1] ?? "";
    };

    const cancels: Array<{ at: number; on: string }> = [];
    for (let at = out.indexOf("preventDefault"); at !== -1; ) {
      cancels.push({ at, on: listener(at) });
      at = out.indexOf("preventDefault", at + 1);
    }

    const mouse = cancels.filter((c) => c.on === "mousedown" || c.on === "click");
    expect(mouse.length).toBe(2);
    for (const c of mouse) {
      const before = out.slice(0, c.at);
      expect(before.lastIndexOf('mode !== "markup"')).toBeGreaterThan(
        before.lastIndexOf("addEventListener"),
      );
    }

    // The hotkeys are the cancels that are not under that guard, and they
    // must not be: they exist to work from a caret in a field, which is use
    // mode by definition. Every one of them is a key press, and nothing but
    // a key press may join them — a mouse cancel outside the guard would be
    // lucid taking a click the document was meant to handle.
    const rest = cancels.filter((c) => c.on !== "mousedown" && c.on !== "click");
    expect(rest.length).toBeGreaterThan(0);
    for (const c of rest) expect(c.on).toBe("keydown");
  });

  test("only a real person's events count", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // Every listener reading a user interaction guards on isTrusted, so a
    // document dispatching its own click is doing its own work and lucid
    // does not read it as a selection. Some guards also test the mode, so
    // the check is for the isTrusted clause rather than a whole line.
    const interaction = out.match(/document\.addEventListener\(/g) ?? [];
    const guards = out.match(/if \(!e\.isTrusted/g) ?? [];
    expect(interaction.length).toBeGreaterThan(0);
    expect(guards.length).toBe(interaction.length);
  });

  test("the one listener that is not a user interaction guards on the sender", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // The parent asks the frame for snippets and for which spots to mark.
    // `isTrusted` says nothing there — every postMessage is trusted — so the
    // check that matters is which window sent it.
    expect(out).toContain("window.addEventListener");
    expect(out).toContain("if (e.source !== parent) return;");
    // And it still refuses anything that is not lucid's own message.
    expect(out).toContain("m.source !== SOURCE");
  });
});

describe("what lucid added is not part of what gets saved", () => {
  test("the snapshot strips lucid's own script, style, and attributes", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // The cleaning happens inside the frame — the parent cannot read the
    // DOM — so what is asserted here is that the code to do it is there and
    // removes each thing lucid added.
    expect(out).toContain('querySelectorAll("[data-lucid]")');
    expect(out).toContain("removeAttribute(ATTR)");
    expect(out).toContain("removeAttribute(AUTHOR_ATTR)");
    expect(out).toContain('removeAttribute("contenteditable")');
    expect(out).toContain('"lucid-hover", "lucid-selected", "lucid-noted", "lucid-edited"');
  });

  test("a control's state is written out from the property, not the attribute", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // A ticked box changes `checked` on the element, not the attribute, so
    // serialising without this writes out what the document loaded with.
    expect(out).toContain('setAttribute("checked", "")');
    expect(out).toContain("m.textContent = live.value");
    expect(out).toContain('setAttribute("value", live.value)');
  });

  test("an edit marks the element as the person's, which is what provenance reads", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out).toContain('setAttribute(AUTHOR_ATTR, "human")');
  });

  test("the document setting its own field values is not an edit by the person", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // Both value listeners guard on isTrusted, so the agent's own scripted
    // changes are not mistaken for the human's.
    const guarded =
      out.match(/document\.addEventListener\("(input|change)"[\s\S]{0,80}?isTrusted/g) ?? [];
    expect(guarded.length).toBe(2);
  });
});

describe("two modes, so one click does one thing", () => {
  test("use mode is where the document starts", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out).toContain('var mode = "use"');
  });

  test("text is editable in use mode, and a caret is the browser's job", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // Editable for as long as you are in use mode, rather than after a
    // double-click. That is what gives an I-beam, a caret, and a drag that
    // selects the words to replace — all native, none of it reimplemented.
    expect(out).toContain('setAttribute("contenteditable", editKind(el))');
    expect(out).not.toContain('addEventListener("dblclick"');
  });

  test("a code block is editable, and as plain text", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // It was left out of the list and there was no way to fix a command in
    // a checklist. In a pre a newline is the content, and rich editing puts
    // in div and br to make one — which is then what gets saved.
    expect(out).toContain(',pre"');
    expect(out).toContain('"plaintext-only"');

    // The affordance follows the attribute, not the word "true", or a pre
    // would be editable with nothing on screen saying so.
    expect(out).toContain('[contenteditable]:not([contenteditable="false"])');
  });

  test("a label wrapping a control is never made editable", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // Making it editable swallows the control: the checkbox ends up inside
    // a caret, and the next click toggles it from in there.
    expect(out).toContain('el.querySelector("input,textarea,select,button,a")');
  });

  test("hover and selection are mark-up mode only", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    for (const listener of ["mouseover", "mouseout", "click"]) {
      const at = out.indexOf(`addEventListener("${listener}"`);
      expect(at).toBeGreaterThan(-1);
      // The guard is the first thing in the handler.
      expect(out.slice(at, at + 220)).toContain('mode !== "markup"');
    }
  });

  test("leaving mark-up mode drops the selection", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // It addressed elements for a note, and there is no note being written
    // in use mode.
    expect(out).toContain('if (mode === "use" && selected.length > 0)');
  });
});

describe("a document that gave itself no background", () => {
  test("gets a light ground it can override", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // Agent HTML routinely sets a text colour and no background, then
    // relies on the browser default of white. In a frame with no background
    // of its own that was dark text on a dark page.
    expect(out).toContain(":where(html)");
    // The system colours for whatever scheme the document ends up in, not a
    // fixed white. A document declaring `color-scheme: light dark` renders
    // light text in a dark browser, and a forced white ground made it
    // invisible.
    expect(out).toContain("background: Canvas");
    expect(out).toContain("color: CanvasText");
    expect(out).not.toContain("color-scheme: light;");
  });

  test("the ground carries no specificity, so the document wins", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // Written as :where(html), never as a bare html rule — a document that
    // sets a dark background of its own must keep it.
    const at = out.indexOf("background: Canvas");
    const before = out.slice(Math.max(0, at - 120), at);
    expect(before).toContain(":where(html)");
  });
});

describe("what a save reports as control values", () => {
  test("only things that carry a value, not everything interactive", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // A paragraph lucid made editable has no value, and a link has none
    // either. Reading them put empty entries in the map handed to the
    // agent — a save of a three-box checklist reported six keys, three of
    // them meaningless.
    expect(out).toContain('var VALUED = "input,textarea,select"');
    expect(out).toContain("document.querySelectorAll(VALUED)");
  });

  test("the wider selector is still what keeps a control out of editable text", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out).toContain('var CONTROL = "input,textarea,select,button,a,[contenteditable=true]"');
  });
});

describe("no focus rings", () => {
  test("the browser's default ring is turned off in the document", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out).toContain(":where(*):focus");
    expect(out).toContain(":where(*):focus-visible");
  });

  test("it is a default, not an override", () => {
    // :where() carries no specificity, so a document that styles its own
    // focus still wins. An !important here would take that away, and lucid
    // does not get to restyle a document it was asked to render.
    const out = instrumentArtifact(DOC, "doc-1", 1);
    const rule = out.slice(out.indexOf(":where(*):focus"), out.indexOf(":where(*):focus") + 120);
    expect(rule).toContain("outline: none");
    expect(rule).not.toContain("!important");
  });

  test("the block holding the caret is tinted, not ringed", () => {
    // Which block you are typing in still has to be visible. The tint says
    // it without drawing the thing this change is about.
    const out = instrumentArtifact(DOC, "doc-1", 1);
    const at = out.indexOf('[contenteditable]:not([contenteditable="false"]):focus');
    const rule = out.slice(at, out.indexOf("}", at));
    expect(rule).toContain("outline: none");
    expect(rule).toContain("background: rgba(13, 148, 136, 0.08)");
  });

  test("lucid's own markers are not focus states and stay", () => {
    // Hover, selected, noted, and edited say what lucid knows about an
    // element. None of them is the browser saying where the caret is.
    const out = instrumentArtifact(DOC, "doc-1", 1);
    for (const cls of ["lucid-hover", "lucid-selected", "lucid-noted", "lucid-edited"]) {
      const at = out.indexOf(`.${cls} {`);
      expect(at).toBeGreaterThan(-1);
      // Solid for hover, selected and edited; dashed for a spot that
      // carries a note. What matters is that each still draws one.
      expect(out.slice(at, out.indexOf("}", at))).toMatch(/outline: 2px (solid|dashed)/);
    }
  });
});
