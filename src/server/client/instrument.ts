/**
 * What lucid adds to a document so it can be addressed.
 *
 * The parent cannot reach into the frame — that is the point of the
 * sandbox — so everything that has to happen to the document happens
 * inside it, in a script lucid injects. The script assigns an id to every
 * element, draws the hover highlight, tracks the selection, and posts out
 * the selected ids. Nothing else crosses.
 *
 * Instrumentation is added here, in the browser, immediately before the
 * bytes are handed to the frame. It is deliberately not added by the
 * server: the document channel returns exactly what the record holds, so
 * what lucid adds cannot travel anywhere the record's bytes travel. The
 * agent is sent the record's bytes, never a rendered document.
 *
 * Two rules the injected script keeps, both from RFC-06:
 *
 * - **It must not break the document's own behaviour.** Listeners are
 *   passive and in the capture phase; nothing is cancelled, nothing is
 *   stopped, and the document's own handlers run exactly as they would
 *   have.
 * - **It must not mistake the document acting for a person acting.** Only
 *   `isTrusted` events count. A document that dispatches its own synthetic
 *   click is doing its own work, and lucid does not read that as a
 *   selection.
 */
/** Source Serif 4, subset to the one string the frame itself draws - the
 * count chip's digits - so the chip holds the chrome's serif inside a
 * sandbox that cannot reach the page's fonts. Base64 of a woff2 cut from
 * the same file `app.css` self-hosts (digits, space, middle dot; the weight
 * axis survives). `unicode-range` keeps it from shadowing the full face on
 * the behaviour reference, which loads both. */
import frameSerif from "./fonts/source-serif-4-frame.txt";

import { flattenNewlines } from "./snapshot-dom.js";
import { BLOCK_SELECTOR } from "./version-diff.js";

/** Marks a message as lucid's own. Checked by the parent, which also
 * checks the sending window — an opaque origin gives nothing to compare,
 * so identity of the source window is the real check and this is only a
 * shape field. */
export const FRAME_MESSAGE_SOURCE = "lucid-artifact";

/** The attribute carrying lucid's element identity. Assigned by the
 * injected script in document order, never read from the document — an
 * agent-written `id` is the agent's, and may be absent, repeated, or
 * changed between versions. */
export const ELEMENT_ATTR = "data-lucid-el";

/** The attribute carrying a block's note count, written by the injected
 * script from the parent's mark message and read by the count chip's
 * `content: attr(...)`. Lucid's own, so `clean()` strips it from a save. */
export const COUNT_ATTR = "data-lucid-count";

/** `e` + document-order index. The parent validates against this shape
 * before believing an id came from a render it made. */
export const ELEMENT_ID = /^e[0-9]+$/;

/** Who wrote the content in an element. Set on every element when the
 * document is instrumented, from the version's own author, so a spot can
 * say who wrote it. Editing (a later slice) changes it per element, which
 * is why it lives on the element rather than on the version. */
export const AUTHOR_ATTR = "data-lucid-author";

/** The stylesheet lucid injects into the artifact frame.
 *
 * Exported so the behaviour reference can render the in-document states
 * from the same source the frame uses. A reference that copied these rules
 * would drift from them, and a drifted reference is worse than none: it
 * would show a designer states the product does not have.
 *
 * THE MARK LANGUAGE (reading-view handoff, "The mark language" + 6f).
 *
 * Two channels, so nothing hides anything:
 *
 * - Persistent marks sit OUTSIDE or AT THE EDGE of the block - the count
 *   chip at its end, the edited rule at its left edge. They survive
 *   without the pointer and never fade.
 * - Transient marks sit ON the block - hover, selection, the editable
 *   cue, the caret block. What you are doing wins over what is already
 *   true, so hover and selection always paint over the persistent marks,
 *   and annotated and edited stay legible underneath them.
 *
 * The one adjustment the composition needs is the chip inverting on a
 * selected block (paper fill, accent-300 border) so it reads against the
 * accent wash. Every other pairing composes without special cases.
 *
 * The tokens are the chrome's own, redefined here because a sandboxed
 * frame cannot inherit custom properties from the page around it. This
 * block and app.css's :root move together: same names, same values. */
const FRAME_TOKENS = `
:root {
  --color-bg: #f3f2f2;
  --color-surface: #eae9e9;
  --color-text: #201e1d;
  --color-accent: #0088b0;
  --color-accent-2: #d6006c;

  --color-neutral-300: #d7d3d3;
  --color-neutral-500: #9b9797;

  --color-accent-100: #e9f8ff;
  --color-accent-200: #cbeeff;
  --color-accent-300: #99e0ff;
  --color-accent-400: #62c5ee;
  --color-accent-800: #004961;

  --color-accent-2-800: #790e3d;

  --font-heading: "Source Serif 4", ui-serif, Georgia, serif;
}

/* The five local tokens, verbatim from the handoff (v2: eggshell, not
   cream - the v1 warm-ink treatment is gone) and identical to the ones
   app.css defines (stage 1). color-mix runs in the browser as-is: this
   sheet is injected as a string, so no pipeline lowers it, and the
   one-rule-per-token shape app.css needs does not apply here. All five
   ride along even though the marks today touch three, so a later stage
   adds marks without re-opening the token block. */
:root {
  --paper: color-mix(in srgb, #fff 94%, var(--color-bg) 6%);
  --ground: var(--color-bg);
  --ground-2: color-mix(in srgb, var(--color-bg) 95%, var(--color-text) 5%);
  --edge: color-mix(in srgb, var(--color-text) 13%, transparent);
  --edge-2: color-mix(in srgb, var(--color-text) 22%, transparent);
}

/* The chip is the only text lucid draws inside the frame, and it is digits.
   unicode-range keeps this face from shadowing the full one anywhere both
   load (the behaviour reference). */
@font-face {
  font-family: "Source Serif 4";
  font-style: normal;
  font-weight: 200 900;
  unicode-range: U+0020, U+0030-0039, U+00B7;
  src: url(data:font/woff2;base64,${frameSerif}) format("woff2");
}
`;

export const STYLE = `
${FRAME_TOKENS}
/* The frame is its own scrolling context. Without this, scrolling past
   either end rubber-bands, which reads as the document coming loose from
   the panel it sits in. */
html {
  overscroll-behavior: none;
}

/* A ground for a document that gave itself none.
 *
 * Agent HTML routinely sets a text colour and no background, then relies on
 * the browser default of white. Rendered in a frame with no background of
 * its own that is dark text on a dark page, and close to unreadable.
 *
 * The :where() wrapper carries no specificity, so a document that sets its own
 * background wins — including a deliberately dark one. A default, not an
 * override. */
:where(html) {
  background: Canvas;
  color: CanvasText;
}

/* No focus ring on the document's own controls either. Zero specificity, so
   this beats the browser default and loses to a document that styles its
   own focus — the same trick as the ground colour above, and for the same
   reason: a default, not an override. */
:where(*):focus,
:where(*):focus-visible {
  outline: none;
}

/* Annotate mode only. In edit mode lucid draws nothing and the document's
   own cursors stand: an I-beam over text, a pointer over a control. */
html.lucid-annotate, html.lucid-annotate * {
  cursor: crosshair !important;
  /* Selectable. user-select: none was here to stop a click that picks an
     element from also leaving a stray selection behind. That also made it
     impossible to drag over a word, which is the other half of marking
     something up: a click takes the whole element, a drag takes what you
     dragged over. A click leaves a collapsed selection, and collapsed
     selections are ignored, so the original problem does not come back. */
  user-select: text !important;
}

/* --- transient marks, on the block --------------------------------
 *
 * Order carries the precedence: hover first, selection after it, so the
 * thing you are doing now beats the thing you are merely near. */

/* Hover: this block is markable. 1px neutral ink at 45%, radius 6px. */
[${ELEMENT_ATTR}].lucid-hover {
  outline: 1px solid color-mix(in srgb, var(--color-text) 45%, transparent) !important;
  outline-offset: 0 !important;
  border-radius: 6px !important;
}

/* Selected: this block is the subject of what you are about to write.
 * 1.5px accent outline, accent-100 fill. The fill is an inset overlay
 * rather than a background, so a block the agent gave its own ground
 * keeps it under the wash instead of losing it. */
[${ELEMENT_ATTR}].lucid-selected {
  outline: 1.5px solid var(--color-accent) !important;
  outline-offset: 0 !important;
  border-radius: 6px !important;
  box-shadow: inset 0 0 0 9999px var(--color-accent-100) !important;
}

/* A text-span selection: a run inside a paragraph, not the whole block.
   One box per visual line - getClientRects() gives a rect per line, so a
   selection that wraps is three boxes rather than one rectangle covering
   the whole paragraph, and a drag that ends mid-word shows that it did.

   The boxes sit over the words, so the fill multiplies against them: the
   accent-200 wash tints the paper and leaves the glyphs readable, the same
   relationship an inline highlight has when it is drawn under the text. */
.lucid-range {
  position: absolute !important;
  pointer-events: none !important;
  z-index: 2147483646 !important;
  mix-blend-mode: multiply !important;
  background: var(--color-accent-200) !important;
  outline: 1.5px solid var(--color-accent) !important;
  border-radius: 3px !important;
}

/* --- edit mode ------------------------------------------------------ */

/* Editable text. Matched on the attribute rather than on "true", because
 * a pre carries plaintext-only and is just as editable.
 *
 * Shown on approach, not always. Every editable block used to carry the
 * cue at all times, which meant lucid drawing on almost every block of a
 * document it did not write. The mode is said by the sheet now, so the
 * cue in the document only has to answer "can I type here" - a question
 * asked about one block, at the moment the pointer is over it. The caret
 * is cyan wherever it lands. */
[${ELEMENT_ATTR}][contenteditable]:not([contenteditable="false"]) {
  outline: none !important;
  caret-color: var(--color-accent) !important;
}
[${ELEMENT_ATTR}][contenteditable]:not([contenteditable="false"]):hover {
  outline: 1px dashed color-mix(in srgb, var(--color-text) 35%, transparent) !important;
  outline-offset: 2px !important;
}
/* No pointer, so nothing to approach with. The persistent cue comes back:
   revealing on approach and showing it always are the same decision said
   for two input devices, not two different decisions. */
@media (hover: none) {
  [${ELEMENT_ATTR}][contenteditable]:not([contenteditable="false"]) {
    outline: 1px dashed color-mix(in srgb, var(--color-text) 35%, transparent) !important;
    outline-offset: 2px !important;
  }
}

/* The block holding the caret: 1.5px ink outline on a paper fill, with the
   2px cyan caret. The fill is an inset overlay, not a background - the
   words stay on top of it, and whatever ground the agent gave the block
   gives way to paper only for as long as the caret is in it. */
[${ELEMENT_ATTR}][contenteditable]:not([contenteditable="false"]):focus {
  outline: 1.5px solid var(--color-text) !important;
  outline-offset: 0 !important;
  border-radius: 6px !important;
  box-shadow: inset 0 0 0 9999px var(--paper) !important;
}

/* --- persistent marks, outside or at the edge ----------------------- */

/* Annotated: the count chip. The ONE persistent mark - every note this
   block has carried, answered or not. It never fades and never clears, so
   it is not an outline over the words but a pill at the block's end:
   17px, accent-100 on accent-800, 10.5px serif. Drawn as a pseudo-element
   reading an attribute, so it never enters the DOM the way a real child
   would: innerText (what a capture quotes) does not see it, and a save
   needs only to strip the attribute.

   No outline declaration here, on purpose. The chip is the whole mark,
   and a rule here - even outline: none - would sit later in the sheet
   than the transient rules and take the selection outline off an
   annotated block, which is exactly the pairing 6f says must compose. */
[${ELEMENT_ATTR}].lucid-noted[${COUNT_ATTR}]::after {
  content: attr(${COUNT_ATTR});
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 17px;
  min-width: 17px;
  padding: 0 6px;
  margin-left: 9px;
  border-radius: 9px;
  box-sizing: border-box;
  background: var(--color-accent-100);
  color: var(--color-accent-800);
  font: 600 10.5px / 1 var(--font-heading);
  vertical-align: 2px;
  white-space: nowrap;
}

/* The one composition that needs help: on a selected block the chip
   inverts - paper fill, accent-300 border - so it stays readable against
   the accent wash. Everything else about the two channels composes. */
[${ELEMENT_ATTR}].lucid-noted.lucid-selected[${COUNT_ATTR}]::after {
  background: var(--paper);
  border: 1px solid var(--color-accent-300);
}

/* Edited, unsaved: a 2px accent-400 rule on the left edge. An inset
   overlay rather than a border, so a block does not shift two pixels the
   moment the first keystroke lands in it. Like the chip, it declares no
   outline: its channel is the edge, and the transient marks above keep
   theirs even while this one is showing (6f, defect 3). */
[${ELEMENT_ATTR}].lucid-edited {
  box-shadow: inset 2px 0 0 var(--color-accent-400) !important;
}

/* Edited and selected: the selection's fill and the edit's rule are
   different edges of the same block, so both show. */
[${ELEMENT_ATTR}].lucid-edited.lucid-selected {
  box-shadow: inset 0 0 0 9999px var(--color-accent-100),
    inset 2px 0 0 var(--color-accent-400) !important;
}

/* Edited with the caret in it: the paper fill the caret block takes, with
   the rule still at the edge. */
[${ELEMENT_ATTR}][contenteditable].lucid-edited:not([contenteditable="false"]):focus {
  box-shadow: inset 0 0 0 9999px var(--paper),
    inset 2px 0 0 var(--color-accent-400) !important;
}

/* The lost seam: a 2px dashed rule in the gap between blocks, where a
   note pointed at prose that no longer exists. Not an error - a fact
   about history - so it is drawn in the edge ink, never magenta. The
   label is the document's own sans: it is inside the page, not chrome.
   .mid is the compare vocabulary (6b): a line either side, label
   centred. */
.lucid-seam {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 7px;
  margin: 0 -7px;
}
.lucid-seam::before {
  content: "";
  flex: 1;
  height: 2px;
  border-radius: 2px;
  background: repeating-linear-gradient(
    90deg,
    var(--edge-2) 0 5px,
    transparent 5px 9px
  );
}
.lucid-seam.mid::after {
  content: "";
  flex: 1;
  height: 2px;
  border-radius: 2px;
  background: repeating-linear-gradient(
    90deg,
    var(--edge-2) 0 5px,
    transparent 5px 9px
  );
}
.lucid-seam .lucid-seam-label {
  font: 400 11.5px / 1 ui-sans-serif, system-ui, sans-serif;
  color: var(--color-neutral-500);
  white-space: nowrap;
}

/* The compare marks (6b). A diff is not a refusal, so neither side ever
   takes magenta: the newer side wears the accent - the same 2px left rule
   and wash an edit wears - and the older side wears neutral ink at a
   third and four percent. Inset overlays, like every other edge mark, so
   nothing shifts when the marks land. */
[${ELEMENT_ATTR}].lucid-diff-new {
  box-shadow: inset 2px 0 0 var(--color-accent),
    inset 0 0 0 9999px var(--color-accent-100) !important;
}
[${ELEMENT_ATTR}].lucid-diff-old {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-text) 30%, transparent),
    inset 0 0 0 9999px color-mix(in srgb, var(--color-text) 4%, transparent) !important;
}

/* --- arrivals -------------------------------------------------------- */

/* New material, when a version arrives and you can already see it (#181).
 *
 * Accent light: a 1.5px accent outline and an accent-100 fill, washing in
 * and out once. The rise is quick and the fall is slow - the wash peaks a
 * fifth of the way through and fades over the rest, which is v1's shape. A
 * pulse that fades in as slowly as it fades out reads as the page loading
 * rather than as something being pointed at.
 *
 * Alternated under two names for the reason focus is: CSS will not replay an
 * animation whose name has not changed, and two versions in a row touching
 * the same block is ordinary. The transparent outline the keyframes animate
 * is what keeps the resting block from carrying a visible outline for the
 * 2.6s. */
@keyframes lucid-new-a {
  0% { box-shadow: inset 0 0 0 9999px transparent; outline-color: transparent; }
  20% { box-shadow: inset 0 0 0 9999px var(--color-accent-100); outline-color: var(--color-accent); }
  100% { box-shadow: inset 0 0 0 9999px transparent; outline-color: transparent; }
}
@keyframes lucid-new-b {
  0% { box-shadow: inset 0 0 0 9999px transparent; outline-color: transparent; }
  20% { box-shadow: inset 0 0 0 9999px var(--color-accent-100); outline-color: var(--color-accent); }
  100% { box-shadow: inset 0 0 0 9999px transparent; outline-color: transparent; }
}
[${ELEMENT_ATTR}].lucid-new-a,
[${ELEMENT_ATTR}].lucid-new-b {
  border-radius: 6px !important;
  outline: 1.5px solid transparent !important;
}
[${ELEMENT_ATTR}].lucid-new-a { animation: lucid-new-a 2.6s ease-in-out 1 !important; }
[${ELEMENT_ATTR}].lucid-new-b { animation: lucid-new-b 2.6s ease-in-out 1 !important; }
@media (prefers-reduced-motion: reduce) {
  [${ELEMENT_ATTR}].lucid-new-a,
  [${ELEMENT_ATTR}].lucid-new-b {
    animation: none !important;
    outline: 1.5px solid var(--color-accent) !important;
    outline-offset: 0 !important;
  }
}

/* Focusing a note's target, or travelling to a block: light it in place.
   A HOLD, not a pulse: the reader asked for this and then looked away, so
   the light has to survive the scroll and say move your eyes here - the
   old 2.6s half-wave peaked at a tenth tint and was gone before anyone
   found it (Kevin, 2026-08-29). Six seconds at accent-200 with a 2px
   edge, then a fast drop.

   Alternated under two class names, because re-running an animation on an
   element that already carries it does nothing - and focusing the same
   note twice is the ordinary case. */
@keyframes lucid-focus-a {
  0%, 92% { box-shadow: inset 0 0 0 9999px var(--color-accent-200); outline-color: var(--color-accent); }
  100% { box-shadow: inset 0 0 0 9999px transparent; outline-color: transparent; }
}
@keyframes lucid-focus-b {
  0%, 92% { box-shadow: inset 0 0 0 9999px var(--color-accent-200); outline-color: var(--color-accent); }
  100% { box-shadow: inset 0 0 0 9999px transparent; outline-color: transparent; }
}
[${ELEMENT_ATTR}].lucid-focus-a,
[${ELEMENT_ATTR}].lucid-focus-b {
  border-radius: 6px !important;
  outline: 2px solid transparent !important;
}
[${ELEMENT_ATTR}].lucid-focus-a { animation: lucid-focus-a 6s ease-in 1 !important; }
[${ELEMENT_ATTR}].lucid-focus-b { animation: lucid-focus-b 6s ease-in 1 !important; }
/* Still says where it went, without moving anything. */
@media (prefers-reduced-motion: reduce) {
  [${ELEMENT_ATTR}].lucid-focus-a,
  [${ELEMENT_ATTR}].lucid-focus-b {
    animation: none !important;
    outline: 2px solid var(--color-accent) !important;
    outline-offset: 0 !important;
  }
}
`;

/** The injected script, as source. It runs inside the frame, where lucid's
 * own code cannot otherwise go. */
const script = (artifactId: string, version: number, author: string): string => `
(function () {
  var SOURCE = ${JSON.stringify(FRAME_MESSAGE_SOURCE)};
  var ATTR = ${JSON.stringify(ELEMENT_ATTR)};
  var ARTIFACT = ${JSON.stringify(artifactId)};
  var VERSION = ${JSON.stringify(version)};
  var AUTHOR_ATTR = ${JSON.stringify(AUTHOR_ATTR)};
  var AUTHOR = ${JSON.stringify(author)};
  var COUNT_ATTR = ${JSON.stringify(COUNT_ATTR)};

  // An id per element, in document order. Assigned by lucid rather than
  // taken from the document: an agent-written id may be missing, repeated,
  // or different in the next version, and none of those can be an address.
  var n = 0;
  var all = document.body ? document.body.querySelectorAll("*") : [];
  for (var i = 0; i < all.length; i++) {
    all[i].setAttribute(ATTR, "e" + ++n);
    // Whoever wrote this version wrote every spot in it. A later slice lets
    // a person edit, and sets this per element where they did.
    if (!all[i].hasAttribute(AUTHOR_ATTR)) all[i].setAttribute(AUTHOR_ATTR, AUTHOR);
  }

  var selected = [];
  var hovered = null;
  // A pick is either a set of elements or one stretch of selected text,
  // never both: they are two answers to the same question and showing both
  // would leave the note pointing at two different things.
  var picked = null;
  var dirty = false;
  var editedCount = 0;
  // "edit" — the document behaves as the agent built it: controls work, text
  // has a caret, drag selects text. "annotate" — clicking picks elements to
  // write notes about, and a click does NOT also operate a control.
  //
  // The two were one mode, and a single click did both: it ticked a box and
  // selected the row at the same time. Nothing said which was happening.
  //
  // Annotate is where a document opens. The page defaults to it too, and both
  // have to agree from the first paint: a frame starting in edit mode would
  // render every block editable for the moment before the page's first mode
  // message arrives.
  var mode = "annotate";
  // A version that is not the current one is read only: it cannot be edited
  // and it cannot be marked up. RFC-07 R6 and R7. This is not a third mode -
  // the mode is still whatever it is, and it applies again the moment the
  // current version is back on screen.
  var readOnly = false;

  // Things a person can operate. Used to decide what must NOT be made
  // editable — a label wrapping one of these would swallow it.
  var CONTROL = "input,textarea,select,button,a,[contenteditable=true]";
  // Things that carry a value the agent authored. Narrower on purpose: a
  // paragraph lucid made editable, or a link, has no value, and reading
  // them put empty entries in the map the agent is handed.
  var VALUED = "input,textarea,select";
  // Text that can hold a caret: a leaf block with no control inside it.
  // Never a label wrapping a checkbox — making that editable swallows the
  // control and the next click toggles it from inside the caret.
  var EDITABLE = "p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt,figcaption,pre";

  var editable = function (el) {
    if (!el.matches(EDITABLE)) return false;
    if (el.querySelector("input,textarea,select,button,a")) return false;
    return (el.textContent || "").trim() !== "";
  };

  // How the caret behaves in a block. In a pre, a newline IS the content
  // and the browser's rich editing inserts div and br to make one — which
  // is then what gets saved as the next version of the document. Plain-text
  // editing puts in a newline character, which is what a pre means.
  var editKind = function (el) {
    return el.matches("pre") ? "plaintext-only" : "true";
  };

  var applyMode = function () {
    var html = document.documentElement;
    if (mode === "annotate" && !readOnly) html.classList.add("lucid-annotate");
    else html.classList.remove("lucid-annotate");

    var all = document.body ? document.body.querySelectorAll("[" + ATTR + "]") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!readOnly && mode === "edit" && editable(el))
        el.setAttribute("contenteditable", editKind(el));
      else el.removeAttribute("contenteditable");
    }
    if (hovered) { hovered.classList.remove("lucid-hover"); hovered = null; }
    // A control focused while using the document keeps its caret otherwise,
    // which reads as still being editable after the mode has changed.
    if (mode === "annotate" && document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  };

  // A control the agent authored is addressed by lucid's element id, so a
  // value survives a document whose own ids are absent or repeated.
  var readValues = function () {
    var out = {};
    var els = document.querySelectorAll(VALUED);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute(ATTR);
      if (!key) continue;
      if (el.type === "checkbox" || el.type === "radio") out[key] = el.checked ? "on" : "";
      else out[key] = String(el.value == null ? "" : el.value);
    }
    return out;
  };

  // The real function, injected by its own source. It lives in
  // snapshot-dom.ts so that a test can run it against a document; the frame
  // cannot import, so this is how one implementation serves both.
  var flattenNewlines = ${flattenNewlines.toString()};

  // What lucid added comes back out: the document is saved as the agent
  // would read it, not as lucid rendered it.
  var clean = function () {
    var copy = document.documentElement.cloneNode(true);
    var added = copy.querySelectorAll("[data-lucid]");
    for (var a = 0; a < added.length; a++) added[a].parentNode.removeChild(added[a]);
    var marked = copy.querySelectorAll("[" + ATTR + "]");
    for (var b = 0; b < marked.length; b++) {
      var m = marked[b];
      // Read the key before removing it: it is the only link between this
      // copy and the live element whose state has to be written out.
      var key = m.getAttribute(ATTR);
      var live = key ? document.querySelector("[" + ATTR + '="' + key + '"]') : null;
      // A control's current state lives on the DOM property, not on the
      // attribute, so serialising the clone without this writes out the
      // values the document loaded with rather than the ones on screen.
      if (live) {
        if (live.type === "checkbox" || live.type === "radio") {
          if (live.checked) m.setAttribute("checked", "");
          else m.removeAttribute("checked");
        } else if (live.tagName === "TEXTAREA") {
          m.textContent = live.value;
        } else if (live.tagName === "INPUT") {
          m.setAttribute("value", live.value);
        }
      }
      m.removeAttribute(ATTR);
      m.removeAttribute(AUTHOR_ATTR);
      m.removeAttribute(COUNT_ATTR);
      m.removeAttribute("contenteditable");
      m.classList.remove("lucid-hover", "lucid-selected", "lucid-noted", "lucid-edited");
      if (m.getAttribute("class") === "") m.removeAttribute("class");
    }
    var pres = copy.querySelectorAll("pre");
    for (var c = 0; c < pres.length; c++) flattenNewlines(pres[c]);
    return "<!doctype html>" + copy.outerHTML;
  };

  // Text is editable for as long as you are in edit mode, rather than after
  // a double-click. That is what gives a caret, an I-beam, and a drag that
  // selects the words you want to replace — all of it the browser's, none
  // of it lucid's to reimplement badly.

  // Where the selection sits, in this frame's own viewport. The parent puts
  // the note box beside it and cannot read the document to work it out.
  var rectOf = function () {
    if (picked && picked.range) {
      var q = picked.range.getBoundingClientRect();
      if (q.width > 0 || q.height > 0) {
        return { x: q.left, y: q.top, width: q.width, height: q.height };
      }
    }
    var l = 1 / 0, t = 1 / 0, r = -1 / 0, b = -1 / 0, any = false;
    for (var i = 0; i < selected.length; i++) {
      var el = document.querySelector("[" + ATTR + '="' + selected[i] + '"]');
      if (!el) continue;
      var q = el.getBoundingClientRect();
      if (q.width === 0 && q.height === 0) continue;
      any = true;
      if (q.left < l) l = q.left;
      if (q.top < t) t = q.top;
      if (q.right > r) r = q.right;
      if (q.bottom > b) b = q.bottom;
    }
    if (!any) return null;
    return { x: l, y: t, width: r - l, height: b - t };
  };

  var post = function () {
    parent.postMessage(
      {
        source: SOURCE,
        kind: "selection",
        artifactId: ARTIFACT,
        version: VERSION,
        // A range pick reports the element it sits in, so everything the
        // page already does with an id keeps working. What narrows it to
        // the selected words is the quote, which is absent for a click.
        ids: picked ? [picked.id] : selected.slice(),
        quote: picked ? picked.exact : "",
        rect: rectOf()
      },
      "*"
    );
  };

  // Scrolling the document moves what the note box is pointing at, so the
  // rect is sent again rather than left behind on screen.
  var repost = function () {
    if (selected.length > 0) post();
  };

  // The frame has its own keyboard, so a key pressed with the caret in the
  // document never reaches the page. The mode toggle has to work from in
  // here, which means asking the same question and handing the answer out.
  document.addEventListener(
    "keydown",
    function (e) {
      if (!e.isTrusted) return;
      // Command-Enter: send the queued notes. Whether any are queued is the
      // page's to know, so this only reports the press. A document has no
      // meaning for this combination, so nothing is taken from it.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        parent.postMessage({ source: SOURCE, kind: "hotkey", hotkey: "send-queue" }, "*");
        return;
      }
      if (!e.altKey || e.key !== "Backspace") return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      // The browser would delete the word behind the caret. This is the one
      // key lucid takes from the document, and it takes it in both modes:
      // getting back to annotating from a caret in a field is the whole
      // point of having it.
      e.preventDefault();
      parent.postMessage({ source: SOURCE, kind: "hotkey", hotkey: "toggle-mode" }, "*");
    },
    true
  );
  window.addEventListener("scroll", repost, true);
  window.addEventListener("resize", repost);

  var addressable = function (node) {
    if (!node || node.nodeType !== 1) return null;
    return node.hasAttribute(ATTR) ? node : null;
  };

  // Merge a range's client rects into one box per visual line. The browser
  // returns a rect per line box, and adjacent rects on the same line are
  // separate when the range crosses an inline element, so a bare mapping
  // draws a seam through the middle of a word.
  var coalesceByLine = function (rects) {
    var lines = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.width === 0 || r.height === 0) continue;
      var joined = false;
      for (var j = 0; j < lines.length; j++) {
        var l = lines[j];
        // Same line when the vertical centres are within a rect's height of
        // each other. Comparing tops alone splits a line whenever a
        // superscript or a taller inline sits in it.
        if (Math.abs((r.top + r.bottom) / 2 - (l.top + l.bottom) / 2) < Math.min(r.height, l.height) / 2) {
          l.left = Math.min(l.left, r.left);
          l.right = Math.max(l.right, r.right);
          l.top = Math.min(l.top, r.top);
          l.bottom = Math.max(l.bottom, r.bottom);
          joined = true;
          break;
        }
      }
      if (!joined) lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    return lines;
  };

  // Boxes are data-lucid, so clean() strips them from a saved document
  // exactly as it strips lucid's style and script.
  var paintRange = function () {
    var old = document.querySelectorAll(".lucid-range");
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    if (!picked || !picked.range) return;
    var lines = coalesceByLine(picked.range.getClientRects());
    for (var j = 0; j < lines.length; j++) {
      var l = lines[j];
      var box = document.createElement("div");
      box.className = "lucid-range";
      box.setAttribute("data-lucid", "1");
      // Document coordinates, so the boxes scroll with the text and no
      // scroll listener has to keep them in place.
      box.style.left = l.left + window.scrollX + "px";
      box.style.top = l.top + window.scrollY + "px";
      box.style.width = l.right - l.left + "px";
      box.style.height = l.bottom - l.top + "px";
      document.body.appendChild(box);
    }
  };

  var paint = function () {
    var marked = document.querySelectorAll(".lucid-selected");
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove("lucid-selected");
    for (var j = 0; j < selected.length; j++) {
      var el = document.querySelector("[" + ATTR + '="' + selected[j] + '"]');
      if (el) el.classList.add("lucid-selected");
    }
    paintRange();
  };

  // Capture phase, and nothing is cancelled: the document's own listeners
  // see every event exactly as they would with lucid absent.
  // The parent asks for what is at a set of spots, and for which spots to
  // mark while a note is being composed. Nothing else comes in, and the
  // parent still cannot touch the DOM: it asks, the frame answers.
  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.source !== SOURCE) return;

    if (m.kind === "capture" && Array.isArray(m.ids)) {
      var spots = [];
      for (var k = 0; k < m.ids.length; k++) {
        var el = document.querySelector("[" + ATTR + '="' + String(m.ids[k]) + '"]');
        if (!el) continue;
        // A drag reports what was dragged over. A click reports the whole
        // element. Either way it is what was on screen and not the markup:
        // the person marked what they could read.
        var isPick = picked && String(m.ids[k]) === picked.id;
        var text = isPick ? picked.exact : (el.innerText || el.textContent || "");
        spots.push({
          id: String(m.ids[k]),
          snippet: text.replace(/\\s+/g, " ").trim(),
          // The selected text, so the page can anchor the note to those
          // words rather than to everything around them. Empty for a click.
          quote: isPick ? picked.exact.replace(/\\s+/g, " ").trim() : "",
          author: el.getAttribute(AUTHOR_ATTR) || AUTHOR
        });
      }
      parent.postMessage(
        { source: SOURCE, kind: "captured", artifactId: ARTIFACT, version: VERSION,
          token: typeof m.token === "string" ? m.token : "", spots: spots },
        "*"
      );
      return;
    }

    if (m.kind === "snapshot") {
      parent.postMessage(
        { source: SOURCE, kind: "snapshot-taken", artifactId: ARTIFACT, version: VERSION,
          token: typeof m.token === "string" ? m.token : "",
          html: clean(), values: readValues() },
        "*"
      );
      return;
    }

    if (m.kind === "mode" && (m.mode === "edit" || m.mode === "annotate")) {
      var nextReadOnly = m.readOnly === true;
      if (m.mode !== mode || nextReadOnly !== readOnly) {
        mode = m.mode;
        readOnly = nextReadOnly;
        // Leaving annotate mode drops the selection: it addressed elements
        // for a note, and there is no note being written in edit mode. A
        // version going read only drops it for the same reason - there is
        // nothing to write about a version that cannot be annotated.
        if ((mode === "edit" || readOnly) && (selected.length > 0 || picked)) {
          selected = [];
          picked = null;
          window.getSelection() && window.getSelection().removeAllRanges();
          paint();
          post();
        }
        applyMode();
      }
      return;
    }

    // Backing out of a note. The selection is the frame's, so only the frame
    // can drop it; the parent clearing its own copy would leave the document
    // still painted as selected.
    if (m.kind === "deselect") {
      if (selected.length > 0 || picked) {
        selected = [];
        // The browser's own selection goes with it. Left standing, the next
        // mouseup anywhere would read it and pick those words again.
        picked = null;
        window.getSelection() && window.getSelection().removeAllRanges();
        paint();
        post();
      }
      return;
    }

    // Go to what a note points at (RFC/#178), following the 6a rule.
    //
    // The rule that matters is the first branch: a target already on screen
    // is lit in place and the page does not move - moving a reader who is
    // already looking at the thing is the failure this exists to avoid.
    // Off screen it does NOT scroll either: the frame says so, and the page
    // docks a travel offer at the sheet edge nearest the target instead.
    // Taking the offer is the only thing that centres the target.
    if (m.kind === "focus" && Array.isArray(m.ids)) {
      // A note can cover several elements. All of them light; the first one
      // that exists is what the page travels to, because only one thing can
      // be centred.
      var hits = [];
      for (var f = 0; f < m.ids.length; f++) {
        var hit = document.querySelector("[" + ATTR + '="' + String(m.ids[f]) + '"]');
        if (hit) hits.push(hit);
      }
      var target = hits.length > 0 ? hits[0] : null;
      // Nothing to go to. The page is told so it can say where the note
      // went instead of leaving the click looking broken.
      if (!target) {
        parent.postMessage({ source: SOURCE, kind: "focus-missed" }, "*");
        return;
      }
      var fr = target.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      // Fully in view, both edges. A block half off the bottom is not
      // "already where you are looking".
      var whole = fr.top >= 0 && fr.bottom <= vh;
      if (!whole) {
        // 6a, off screen: no scroll, no light. The page offers the jump;
        // only taking it moves the document.
        var at = indexOfBlock(target);
        if (at === -1) {
          parent.postMessage({ source: SOURCE, kind: "focus-missed" }, "*");
          return;
        }
        parent.postMessage(
          { source: SOURCE, kind: "focus-offscreen", artifactId: ARTIFACT,
            version: VERSION, index: at, below: fr.top >= vh },
          "*"
        );
        return;
      }
      // Alternated, because re-adding a class an element already carries
      // does not restart its animation.
      var was = target.classList.contains("lucid-focus-a");
      var lit = was ? "lucid-focus-b" : "lucid-focus-a";
      for (var g = 0; g < hits.length; g++) {
        hits[g].classList.remove("lucid-focus-a", "lucid-focus-b");
        // Forces the removal to land before the other class is added.
        void hits[g].offsetWidth;
        hits[g].classList.add(lit);
        (function (el, cls) {
          setTimeout(function () {
            el.classList.remove(cls);
          }, 6000);
        })(hits[g], lit);
      }
      return;
    }

    // Put the reader back where they were, in a document that has been
    // replaced under them (#180).
    //
    // Addressed by block index rather than by scroll offset. An offset is
    // wrong the moment anything above the reader changes length, which is
    // exactly what a new version does. The page maps the old index to the
    // new one before sending it, using the same block walk that reports what
    // changed, so nothing here has to match anything.
    if (m.kind === "restore-place" && typeof m.index === "number") {
      var backTo = blocks()[m.index];
      if (!backTo) return;
      var want = typeof m.top === "number" ? m.top : 0;
      var have = backTo.getBoundingClientRect().top;
      window.scrollBy(0, have - want);
      return;
    }

    // What this version changed, where the reader can already see it (#181).
    //
    // The whole rule is the split: a block in view pulses and is not
    // travelled to, a block out of view does not pulse and is offered
    // instead - with which edge it sits at, so the page can dock the offer
    // at the edge nearest the target. Pulsing something off screen wastes
    // the one signal there is; scrolling to something already on screen
    // destroys the reader's orientation to make a point they could already
    // see.
    if (m.kind === "pulse" && Array.isArray(m.indexes)) {
      var pl = blocks();
      var vph = window.innerHeight || document.documentElement.clientHeight;
      var awayBelow = [];
      var awayAbove = [];
      var seen = 0;
      for (var q = 0; q < m.indexes.length; q++) {
        var pe = pl[m.indexes[q]];
        if (!pe) continue;
        var pr = pe.getBoundingClientRect();
        // Any part of it on screen counts as seen. A block whose first line
        // is visible has been read up to, and jumping to it would move the
        // page for something already in front of the reader.
        if (pr.top < vph && pr.bottom > 0) {
          var pwas = pe.classList.contains("lucid-new-a");
          var pcls = pwas ? "lucid-new-b" : "lucid-new-a";
          pe.classList.remove("lucid-new-a", "lucid-new-b");
          void pe.offsetWidth;
          pe.classList.add(pcls);
          (function (el, cls) {
            setTimeout(function () { el.classList.remove(cls); }, 2600);
          })(pe, pcls);
          seen += 1;
        } else if (pr.top >= vph) {
          awayBelow.push(m.indexes[q]);
        } else {
          awayAbove.push(m.indexes[q]);
        }
      }
      parent.postMessage(
        { source: SOURCE, kind: "pulsed", artifactId: ARTIFACT, version: VERSION,
          shown: seen, below: awayBelow, above: awayAbove },
        "*"
      );
      return;
    }

    // Travel to a block by its number, for the half of the rule that does
    // not pulse. Same lighting as focusing a note: arriving somewhere is
    // arriving somewhere, whichever asked.
    if (m.kind === "go-block" && typeof m.index === "number") {
      var gl = blocks()[m.index];
      if (!gl) return;
      gl.scrollIntoView({ block: "center", inline: "nearest" });
      var gwas = gl.classList.contains("lucid-focus-a");
      var gcls = gwas ? "lucid-focus-b" : "lucid-focus-a";
      gl.classList.remove("lucid-focus-a", "lucid-focus-b");
      void gl.offsetWidth;
      gl.classList.add(gcls);
      (function (el, cls) {
        setTimeout(function () { el.classList.remove(cls); }, 6000);
      })(gl, gcls);
      return;
    }

    // Which blocks carry notes, and how many each has carried. The chip is
    // the one persistent mark, so this is state rather than decoration:
    // the count stays until it is replaced, and it never fades on its own.
    if (m.kind === "mark" && m.counts && typeof m.counts === "object") {
      var was = document.querySelectorAll(".lucid-noted");
      for (var a = 0; a < was.length; a++) {
        was[a].classList.remove("lucid-noted");
        was[a].removeAttribute(COUNT_ATTR);
      }
      for (var key in m.counts) {
        if (!Object.prototype.hasOwnProperty.call(m.counts, key)) continue;
        var mel = document.querySelector("[" + ATTR + '="' + String(key) + '"]');
        var count = m.counts[key];
        if (mel && typeof count === "number" && count >= 1) {
          mel.classList.add("lucid-noted");
          mel.setAttribute(COUNT_ATTR, String(count));
        }
      }
      // The marks-below count follows the chips, not the scroll: a note
      // landing under the fold changes the pill without a scroll event.
      reportBelow();
      return;
    }

    // Where a lost note pointed (3e): a seam drawn in the gap where the
    // passage was. The page works out where; the frame owns the DOM.
    // Clicking one opens the version where the note still reads, so a
    // version rides along and comes back on the click.
    if (m.kind === "seam" && Array.isArray(m.seams)) {
      clearSeams();
      var slist = blocks();
      for (var s = 0; s < m.seams.length; s++) {
        var one = m.seams[s];
        if (one === null || typeof one !== "object") continue;
        if (typeof one.before !== "number" || typeof one.label !== "string") continue;
        addSeam(slist, one);
      }
      return;
    }

    // The compare marks (6b): which blocks changed on this side. Sent on a
    // timer by the page, like the mode message, because a fresh frame has
    // to hear it whenever it becomes ready.
    if (m.kind === "compare" && (m.side === "new" || m.side === "old")) {
      var cls = m.side === "new" ? "lucid-diff-new" : "lucid-diff-old";
      var other = m.side === "new" ? "lucid-diff-old" : "lucid-diff-new";
      var cleared = document.querySelectorAll("." + other);
      for (var c = 0; c < cleared.length; c++) cleared[c].classList.remove(other);
      var clist = blocks();
      var marks = Array.isArray(m.marks) ? m.marks : [];
      for (var d = 0; d < marks.length; d++) {
        var cel = clist[marks[d]];
        if (cel) cel.classList.add(cls);
      }
      // A block the newer side lost is a seam there, in the same vocabulary
      // as a lost note's passage.
      if (Array.isArray(m.seams)) {
        clearSeams();
        for (var e = 0; e < m.seams.length; e++) {
          var spec = m.seams[e];
          if (spec === null || typeof spec !== "object") continue;
          if (typeof spec.before !== "number" || typeof spec.label !== "string") continue;
          addSeam(clist, spec);
        }
      }
      return;
    }
  });

  // The frame's blocks, in the order collectBlocks produces them: the same
  // selector, skipping a block that holds another block, skipping empty ones.
  // Ordering has to agree exactly, because the page addresses them by index.
  var BLOCKS = "${BLOCK_SELECTOR}";
  var blocks = function () {
    var all = document.querySelectorAll(BLOCKS);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].querySelector(BLOCKS)) continue;
      if ((all[i].textContent || "").replace(/s+/g, " ").trim() === "") continue;
      out.push(all[i]);
    }
    return out;
  };

  // The block an element is, sits in, or wraps. A note's target is usually
  // a block itself; a spot inside a control's label is not. -1 when the
  // element names no block, which is the page's cue that there is nowhere
  // to offer a jump to.
  var indexOfBlock = function (el) {
    var list = blocks();
    for (var i = 0; i < list.length; i++) if (list[i] === el) return i;
    for (var j = 0; j < list.length; j++) {
      if (list[j].contains(el) || el.contains(list[j])) return j;
    }
    return -1;
  };

  // Seams are lucid's own DOM, marked data-lucid so a save strips them with
  // everything else lucid added.
  var clearSeams = function () {
    var old = document.querySelectorAll(".lucid-seam");
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
  };

  var addSeam = function (list, spec) {
    var seam = document.createElement("div");
    seam.className = "lucid-seam" + (spec.mid === true ? " mid" : "");
    seam.setAttribute("data-lucid", "1");
    var label = document.createElement("span");
    label.className = "lucid-seam-label";
    label.textContent = spec.label;
    seam.appendChild(label);
    if (typeof spec.version === "number") {
      // Clicking a seam opens the version where the passage still lives.
      seam.style.cursor = "pointer";
      seam.addEventListener("click", function () {
        parent.postMessage(
          { source: SOURCE, kind: "seam-clicked", version: spec.version },
          "*"
        );
      });
    }
    if (list.length === 0) {
      document.body.appendChild(seam);
      return;
    }
    var at = spec.before >= list.length ? null : list[spec.before];
    if (at && at.parentNode) {
      at.parentNode.insertBefore(seam, at);
      return;
    }
    var last = list[list.length - 1];
    if (last && last.parentNode) last.parentNode.insertBefore(seam, last.nextSibling);
    else document.body.appendChild(seam);
  };

  // Which noted blocks sit wholly below the fold (3g). The page draws the
  // count pill from this; it never works out positions for itself, because
  // only this frame knows where the fold is.
  var reportBelow = function () {
    var list = blocks();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].classList.contains("lucid-noted")) continue;
      var r = list[i].getBoundingClientRect();
      if (r.top >= vh) out.push(i);
    }
    parent.postMessage(
      { source: SOURCE, kind: "marks-below", artifactId: ARTIFACT, version: VERSION,
        indexes: out },
      "*"
    );
  };

  // Where the reader is, pushed rather than asked for.
  //
  // Pushed because by the time it is needed the frame is gone: a new version
  // replaces this document, so the page has to already hold the answer. It
  // cannot ask for it after the fact.
  var placeTimer = null;
  var reportPlace = function () {
    var list = blocks();
    for (var i = 0; i < list.length; i++) {
      var r = list[i].getBoundingClientRect();
      // The first block whose bottom is still below the top edge: what the
      // reader is looking at, rather than what has scrolled past.
      if (r.bottom > 0) {
        parent.postMessage(
          { source: SOURCE, kind: "place", artifactId: ARTIFACT, version: VERSION,
            // Not rounded. The offset is put back by scrolling the
            // difference, and a rounded one lands within a pixel but not on
            // the same sub-pixel, which re-rasterises every glyph.
            index: i, top: r.top },
          "*"
        );
        return;
      }
    }
  };
  window.addEventListener("scroll", function () {
    if (placeTimer !== null) return;
    placeTimer = setTimeout(function () {
      placeTimer = null;
      reportPlace();
      // The fold moved, so the marks-below count moved with it (3g).
      reportBelow();
    }, 150);
  }, { passive: true });
  // The page cannot restore a place until the document exists to hold one,
  // and srcdoc loads on its own schedule. Saying so beats guessing at a
  // delay or resending until something sticks.
  parent.postMessage(
    { source: SOURCE, kind: "ready", artifactId: ARTIFACT, version: VERSION },
    "*"
  );
  // Once at the start, so a reader who never scrolls still has a place.
  setTimeout(reportPlace, 0);
  // And so the 3g pill knows where the fold sat when the frame opened.
  setTimeout(reportBelow, 0);

  var touched = function (el) {
    if (!el || el.nodeType !== 1 || !el.hasAttribute(ATTR)) return;
    el.setAttribute(AUTHOR_ATTR, "human");
    el.classList.add("lucid-edited");
    // How many blocks carry an edit, so the discard dialog can name the
    // quantity (6c: "Discard your three edits?"). Posted when the count
    // changes rather than on every keystroke: the first touch says the
    // document is dirty, and each new block touched says there is one more
    // thing at stake.
    var edits = document.querySelectorAll(".lucid-edited").length;
    if (!dirty || edits !== editedCount) {
      dirty = true;
      editedCount = edits;
      parent.postMessage(
        { source: SOURCE, kind: "dirty", artifactId: ARTIFACT, version: VERSION,
          edits: edits },
        "*"
      );
    }
  };

  // What the person does to a control, and what they type into prose. Only
  // trusted events: a document setting its own field values is the agent's
  // own work, not an edit by the person.
  document.addEventListener("input", function (e) {
    if (!e.isTrusted) return;
    touched(e.target);
  }, true);
  document.addEventListener("change", function (e) {
    if (!e.isTrusted) return;
    touched(e.target);
  }, true);

  // Applied before any event is handled, so the document opens in the mode
  // it will stay in rather than changing under the first click.
  applyMode();

  // Focus moves on mousedown, not on click. Cancelling only the click let
  // the browser focus a textarea and draw a caret first, and the element
  // was then highlighted for annotation a moment later — two things
  // happening from one press, in the wrong order.
  document.addEventListener("mousedown", function (e) {
    if (!e.isTrusted || mode !== "annotate" || readOnly) return;
    // Cancelling every mousedown also cancels the browser's own text
    // selection, which is what a drag is made of - so annotating a phrase
    // was impossible for as long as this was unconditional.
    //
    // What it is actually for is controls: focus moves on mousedown, so a
    // press on a textarea drew a caret before the click could pick the
    // element, and one press did two things in the wrong order. That is
    // still cancelled. A press on prose is left alone, and the drag it
    // starts is the browser's.
    var t = e.target;
    if (t && t.nodeType === 1 && (t.matches(CONTROL) || t.closest(CONTROL))) {
      e.preventDefault();
    }
  }, true);

  document.addEventListener("mouseover", function (e) {
    if (!e.isTrusted || mode !== "annotate" || readOnly) return;
    var el = addressable(e.target);
    if (el === hovered) return;
    if (hovered) hovered.classList.remove("lucid-hover");
    hovered = el;
    if (hovered) hovered.classList.add("lucid-hover");
  }, true);

  document.addEventListener("mouseout", function (e) {
    if (!e.isTrusted || mode !== "annotate" || readOnly) return;
    if (hovered) { hovered.classList.remove("lucid-hover"); hovered = null; }
  }, true);

  // A drag over text picks those words. A click picks the element under it.
  // Both end in a mouseup, so this runs first and decides which happened:
  // an uncollapsed selection is a drag, anything else falls through to the
  // click handler below.
  document.addEventListener("mouseup", function (e) {
    if (!e.isTrusted || mode !== "annotate" || readOnly) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    var exact = sel.toString();
    if (exact.replace(/\\s+/g, " ").trim() === "") return;
    var range = sel.getRangeAt(0);
    // Which element the selection STARTS in. Not the common ancestor: a
    // range crossing two paragraphs has body as its ancestor, and body
    // names no spot.
    var node = range.startContainer;
    var host = node.nodeType === 3 ? node.parentElement : node;
    var el = addressable(host);
    if (!el) return;
    picked = { id: el.getAttribute(ATTR), exact: exact, range: range.cloneRange() };
    // A drag replaces an element pick rather than adding to it.
    selected = [];
    paint();
    post();
  }, true);

  document.addEventListener("click", function (e) {
    // A document that dispatches its own click is doing its own work.
    if (!e.isTrusted || mode !== "annotate" || readOnly) return;
    // A drag ends with a mouseup and then a click. The mouseup already made
    // the pick, so this click must not immediately replace it with the
    // element under the cursor.
    if (picked) {
      var live = window.getSelection();
      if (live && !live.isCollapsed) { e.preventDefault(); return; }
      picked = null;
    }
    // In annotate mode a click picks an element and does nothing else. Left
    // to run, it would also tick the box or follow the link under it, so
    // one click would do two things and neither would be undoable.
    e.preventDefault();
    var el = addressable(e.target);
    if (!el) return;
    var id = el.getAttribute(ATTR);
    // Command on a Mac, control elsewhere. Holding it adds a spot to the
    // selection lucid already has; without it a click starts a new one.
    var adding = e.metaKey || e.ctrlKey;
    var at = selected.indexOf(id);
    if (adding) {
      if (at === -1) selected.push(id);
      else selected.splice(at, 1);
    } else {
      selected = at !== -1 && selected.length === 1 ? [] : [id];
    }
    paint();
    post();
  }, true);

  // Clicking away clears. Only elements inside body carry the attribute,
  // so a click on the page's own margin lands here and nowhere else.
  document.addEventListener("click", function (e) {
    if (!e.isTrusted || mode !== "annotate" || readOnly) return;
    if (addressable(e.target)) return;
    if (selected.length === 0 && !picked) return;
    selected = [];
    picked = null;
    paint();
    post();
  }, true);
})();
`;

/** Add lucid's instrumentation to a document's bytes.
 *
 * The style and script go last, so the document's own styles and scripts
 * have already run and lucid's highlight wins on specificity through
 * `!important` rather than through ordering it does not control. */
export const instrumentArtifact = (
  bytes: string,
  artifactId: string,
  version: number,
  author = "agent",
): string => {
  const added = `<style data-lucid="1">${STYLE}</style><script data-lucid="1">${script(artifactId, version, author)}</script>`;
  const close = bytes.lastIndexOf("</body>");
  if (close === -1) return `${bytes}${added}`;
  return `${bytes.slice(0, close)}${added}${bytes.slice(close)}`;
};
