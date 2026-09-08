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
      // The document's own handlers, never a listener lucid hung on an
      // element it made (a seam is clickable, and that click is lucid's).
      const opened = before.lastIndexOf("document.addEventListener(");
      return /"([a-z]+)"/.exec(out.slice(opened, at))?.[1] ?? "";
    };

    const cancels: Array<{ at: number; on: string }> = [];
    for (let at = out.indexOf("preventDefault"); at !== -1; ) {
      cancels.push({ at, on: listener(at) });
      at = out.indexOf("preventDefault", at + 1);
    }

    const mouse = cancels.filter((c) => c.on === "mousedown" || c.on === "click");
    // mousedown, the click that picks an element, and the click that closes
    // a drag. That last one has to be cancelled too: a drag ends with a
    // mouseup and then a click, and letting it through would follow the
    // link the words were selected inside.
    expect(mouse.length).toBe(3);
    for (const c of mouse) {
      const before = out.slice(0, c.at);
      expect(before.lastIndexOf('mode !== "annotate"')).toBeGreaterThan(
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

  test("the count chip's attribute goes back out with the rest of lucid's", () => {
    // The chip is drawn from data-lucid-count, so a save that left the
    // attribute behind would ship a count the next version rendered as a
    // chip nobody asked for.
    const out = instrumentArtifact(DOC, "doc-1", 1);
    expect(out).toContain("removeAttribute(COUNT_ATTR)");
    expect(out).toContain('var COUNT_ATTR = "data-lucid-count"');
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
  test("mark-up mode is where the document starts", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // What a person does with a document an agent produced is read it and
    // say what is wrong with it. Filling it in is the rarer act, and it is
    // the one with a switch to reach it.
    expect(out).toContain('var mode = "annotate"');
    // The page defaults to the same mode. If these ever disagree, the frame
    // renders every block editable for the moment before the page's first
    // mode message lands.
    expect(out).not.toContain('var mode = "edit"');
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
      const at = out.indexOf(`document.addEventListener("${listener}"`);
      expect(at).toBeGreaterThan(-1);
      // The guard is the first thing in the handler.
      expect(out.slice(at, at + 220)).toContain('mode !== "annotate"');
    }
  });

  test("leaving mark-up mode drops the selection", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    // It addressed elements for a note, and there is no note being written
    // in use mode.
    // Read-only drops it for the same reason: there is nothing to write
    // about a version that cannot be annotated.
    expect(out).toContain('if ((mode === "edit" || readOnly) && (selected.length > 0 || picked))');
    // Both kinds of pick, and the browser's own selection with them. A range
    // left standing would be read again by the next mouseup.
    expect(out).toContain("picked = null;");
    expect(out).toContain("removeAllRanges()");
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

  test("edit focus preserves the authored color pair", () => {
    const out = instrumentArtifact(DOC, "doc-1", 1);
    const at = out.indexOf('[contenteditable]:not([contenteditable="false"]):focus');
    const rule = out.slice(at, out.indexOf("}", at));
    expect(rule).toContain("outline: 1.5px solid var(--color-accent)");
    expect(rule).not.toContain("box-shadow:");
    expect(rule).not.toContain("background:");
  });

  test("lucid's own markers each still draw one mark, in their own channel", () => {
    // The mark language (handoff): transient marks take the outline and
    // fill; persistent marks sit outside or at the edge - the noted chip is
    // a pseudo-element reading the count attribute, the edited rule is a
    // 2px accent bar at the left edge. None of them is a focus state, so
    // none may rely on the browser's ring, and each must draw without the
    // others: that is what makes the combinations in 6f read.
    const out = instrumentArtifact(DOC, "doc-1", 1);
    const rule = (cls: string): string => {
      const at = out.indexOf(`.${cls} {`);
      expect(at).toBeGreaterThan(-1);
      return out.slice(at, out.indexOf("}", at));
    };
    // Transient: on the block.
    expect(rule("lucid-hover")).toContain("outline: 2px dotted #b8b8b8");
    expect(rule("lucid-selected")).toContain("outline: 1.5px solid var(--color-accent)");
    // Persistent: at the edge or past it, never over the words. The noted
    // rule declares no outline of its own - a later `outline: none` would
    // take the selection outline off an annotated block, and selection
    // always wins (6f, defect 2).
    expect(out).toContain("attr(data-lucid-count)");
    expect(out.indexOf(".lucid-noted.lucid-selected")).toBeGreaterThan(
      out.indexOf(".lucid-selected {"),
    );
    expect(rule("lucid-edited")).toContain("inset 2px 0 0 var(--color-accent-400)");
  });
});

/** A click takes the whole element; a drag takes the words dragged over.
 * The frame script cannot be imported, so these read the source it injects,
 * the same way the rest of this file does. */
describe("selecting text to mark it up", () => {
  const out = instrumentArtifact(DOC, "doc-1", 1);

  test("mark-up mode allows a selection at all", () => {
    // user-select:none was the whole reason a drag did nothing. If it comes
    // back, selecting a word silently stops working and nothing else fails.
    expect(out).toContain("user-select: text !important");
    expect(out).not.toContain("user-select: none !important");
  });

  test("a drag is read on mouseup, and a collapsed selection is not a drag", () => {
    expect(out).toContain('addEventListener("mouseup"');
    expect(out).toContain("sel.isCollapsed");
  });

  test("the spot is the element the selection starts in", () => {
    // Not the common ancestor: a range across two paragraphs has body as
    // its ancestor, and body names no spot.
    expect(out).toContain("range.startContainer");
  });

  test("a drag replaces an element pick rather than adding to it", () => {
    const at = out.indexOf("picked = {");
    expect(at).toBeGreaterThan(-1);
    expect(out.slice(at, at + 260)).toContain("selected = []");
  });

  test("the click that ends a drag does not also pick the element under it", () => {
    // A drag fires mouseup and then click. Without this the click would
    // immediately replace the words with the paragraph containing them.
    const at = out.indexOf('document.addEventListener("click"');
    expect(out.slice(at, at + 400)).toContain("if (picked)");
  });

  test("the highlight is one box per visual line", () => {
    // One rectangle over the whole paragraph would say the note covers the
    // paragraph, which is the thing this change exists to stop saying.
    expect(out).toContain("coalesceByLine");
    expect(out).toContain("getClientRects()");
  });

  test("the boxes are lucid's, so a save does not contain them", () => {
    // clean() strips [data-lucid]; the boxes carry it for that reason.
    const at = out.indexOf('box.className = "lucid-range"');
    expect(at).toBeGreaterThan(-1);
    expect(out.slice(at, at + 160)).toContain('setAttribute("data-lucid", "1")');
  });

  test("the note box is placed beside the words, not beside the paragraph", () => {
    const at = out.indexOf("var rectOf = function ()");
    expect(out.slice(at, at + 200)).toContain("picked.range.getBoundingClientRect()");
  });

  test("what is captured is the selected text, and it rides as a quote", () => {
    expect(out).toContain("var text = isPick ? picked.exact");
    expect(out).toContain("quote: isPick ? picked.exact");
  });

  test("a press on prose is not cancelled, so the browser can start a drag", () => {
    // This, not the CSS, is what made dragging impossible. Cancelling every
    // mousedown cancels the browser's own text selection, and a drag is made
    // of one. If the guard goes away, selecting a phrase silently stops
    // working and every other test still passes.
    const at = out.indexOf('addEventListener("mousedown"');
    expect(at).toBeGreaterThan(-1);
    const body = out.slice(at, at + 900);
    expect(body).toContain("t.matches(CONTROL)");
    expect(body).toContain("t.closest(CONTROL)");
  });

  test("a press on a control is still cancelled", () => {
    // Focus moves on mousedown, so a press on a textarea drew a caret before
    // the click could pick the element: one press, two things, wrong order.
    const at = out.indexOf('addEventListener("mousedown"');
    const body = out.slice(at, at + 900);
    const guard = body.indexOf("t.matches(CONTROL)");
    expect(body.indexOf("e.preventDefault()", guard)).toBeGreaterThan(guard);
  });

  test("a click still reports no quote", () => {
    // The page branches on it: empty means anchor to the whole element.
    const at = out.indexOf("quote: isPick");
    expect(out.slice(at, at + 120)).toContain(': ""');
  });
});

/** The mark language: two channels, one persistent mark (handoff "The mark
 * language" + 6f). Decided from the bytes, like everything here: what the
 * stylesheet draws and what the script does with a count. */
describe("the mark language", () => {
  const out = instrumentArtifact(DOC, "doc-1", 1);

  test("the frame carries the chrome's own tokens, not literals", () => {
    // A sandboxed frame inherits nothing from the page around it, so the
    // sheet has to bring the custom properties itself - the same names and
    // values app.css defines, which is what lets one mark style hold in the
    // frame and on the reference page without a second vocabulary.
    for (const token of [
      "--color-accent: #0088b0",
      "--color-accent-100: #e9f8ff",
      "--paper: color-mix(in srgb, #fff 94%, var(--color-bg) 6%)",
      "--font-heading:",
    ]) {
      expect(out).toContain(token);
    }
  });

  test("the count chip is drawn from the attribute, never the DOM", () => {
    // A real child element would enter innerText - which is what a capture
    // quotes and a note anchors to - and would need stripping from saves.
    // A pseudo-element reading an attribute touches neither. The elements
    // the script does create are lucid's own decorations - the drag boxes
    // and the seams - every one of them under a data-lucid mark so clean()
    // takes them out of a save.
    expect(out).toContain("content: attr(data-lucid-count)");
    expect(out.match(/createElement\(/g) ?? []).toHaveLength(3);
    expect(out).toContain('box.className = "lucid-range"');
    expect(out).toContain('seam.className = "lucid-seam"');
    expect(out).toContain('seam.setAttribute("data-lucid", "1")');
  });

  test("the chip inverts on a selected block, and nothing else needs to", () => {
    // The one adjustment 6f makes: paper fill and an accent-300 border, so
    // the tally stays readable against the accent wash.
    const at = out.indexOf(".lucid-noted.lucid-selected");
    expect(at).toBeGreaterThan(-1);
    const rule = out.slice(at, out.indexOf("}", out.indexOf("}", at + 1) + 1));
    expect(rule).toContain("background: var(--paper)");
    expect(rule).toContain("border: 1px solid var(--color-accent-300)");
  });

  test("a mark message carries counts, not just presence", () => {
    // The chip answers "how many notes", so the parent sends a tally per
    // block and the frame writes it to the attribute the chip reads.
    // Element ids are still validated by shape before use.
    expect(out).toContain('m.kind === "mark" && m.counts');
    expect(out).toContain("mel.setAttribute(COUNT_ATTR, String(count))");
    expect(out).not.toContain('m.kind === "mark" && Array.isArray(m.ids)');
  });

  test("a lost seam is defined for the later stages, in edge ink", () => {
    // 3e draws it where a note's passage was removed. It is a fact about
    // history, not an error: dashed edge ink and a sans label, never
    // magenta, never accent.
    const at = out.indexOf(".lucid-seam::before");
    expect(at).toBeGreaterThan(-1);
    const rule = out.slice(at, out.indexOf("}", at));
    expect(rule).toContain("repeating-linear-gradient");
    expect(rule).toContain("var(--edge-2)");
    expect(rule).not.toContain("accent");
  });

  test("selection preserves the edit edge without covering the authored ground", () => {
    const both = out.indexOf(".lucid-edited.lucid-selected");
    expect(both).toBeGreaterThan(-1);
    expect(out.slice(both, out.indexOf("}", both))).not.toContain("9999px");
    expect(out.slice(both, out.indexOf("}", both))).toContain(
      "inset 2px 0 0 var(--color-accent-400)",
    );
  });
});

/** Stage 3's frame protocol: the seam, the compare marks, the travel rule's
 * off-screen half, the fold count, and the edited count the discard dialog
 * names. Pinned from the bytes like everything here. */
describe("the stage 3 frame protocol", () => {
  const out = instrumentArtifact(DOC, "doc-1", 1);

  test("a seam is inserted before a block index, carries the version it opens, and is lucid's own DOM", () => {
    // The page works out WHERE; the frame owns the DOM. The seam is
    // data-lucid so a save never contains it, and clicking it posts the
    // version back - the way to the copy where the passage still lives.
    expect(out).toContain('m.kind === "seam" && Array.isArray(m.seams)');
    expect(out).toContain('seam.setAttribute("data-lucid", "1")');
    expect(out).toContain('seam.className = "lucid-seam"');
    expect(out).toContain("at.parentNode.insertBefore(seam, at)");
    expect(out).toContain('kind: "seam-clicked", version: spec.version');
  });

  test("a compare message marks one side and clears the other", () => {
    // 6b: the newer side wears accent, the older neutral ink. A repeated
    // message (the timer) must not let the two sides accumulate each
    // other's marks, so the other side's class is cleared first.
    expect(out).toContain('m.kind === "compare" && (m.side === "new" || m.side === "old")');
    expect(out).toContain('var other = m.side === "new" ? "lucid-diff-old" : "lucid-diff-new"');
    expect(out).toContain("classList.remove(other)");
    expect(out).toContain("cel.classList.add(cls)");
  });

  test("the diff marks never take magenta - a diff is not a refusal", () => {
    const atNew = out.indexOf(".lucid-diff-new");
    expect(atNew).toBeGreaterThan(-1);
    expect(out.slice(atNew, out.indexOf("}", atNew))).not.toContain("accent-2");
    const atOld = out.indexOf(".lucid-diff-old");
    expect(out.slice(atOld, out.indexOf("}", atOld))).not.toContain("accent-2");
  });

  test("the focus rule's off-screen half does not scroll - it offers instead (6a)", () => {
    // The old behaviour centred the target. The design forbids that: the
    // page docks a travel offer at the nearer edge, and only taking it
    // moves the document.
    const at = out.indexOf('m.kind === "focus" && Array.isArray(m.ids)');
    const body = out.slice(at, at + 2600);
    expect(body).toContain('kind: "focus-offscreen"');
    expect(body).not.toContain("scrollIntoView");
  });

  test("the pulsed report says which edge each unseen change sat at", () => {
    // The offer docks at the edge nearest the target, so the frame reports
    // above and below separately rather than one undifferentiated list.
    expect(out).toContain("below: awayBelow");
    expect(out).toContain("above: awayAbove");
    expect(out).not.toContain("offscreen: away");
  });

  test("the fold count is pushed, not pulled (3g)", () => {
    // Only the frame knows where the fold is, so it reports the noted
    // blocks wholly below it - on scroll, on mark updates, and once at
    // the start for a reader who never scrolls.
    expect(out).toContain('kind: "marks-below"');
    expect(out.indexOf("reportBelow()")).toBeGreaterThan(out.indexOf('kind: "mark"'));
    expect(out).toContain("setTimeout(reportBelow, 0)");
  });

  test("the dirty message carries the edit count the discard dialog names (6c)", () => {
    // "Discard your three edits?" needs the number. It is posted when the
    // count of edited blocks changes, not on every keystroke.
    const at = out.indexOf('kind: "dirty"');
    expect(out.slice(at - 700, at)).toContain('document.querySelectorAll(".lucid-edited").length');
    expect(out.slice(at, at + 200)).toContain("edits: edits");
  });
});
