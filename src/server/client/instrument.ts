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

/** `e` + document-order index. The parent validates against this shape
 * before believing an id came from a render it made. */
export const ELEMENT_ID = /^e[0-9]+$/;

const STYLE = `
[${ELEMENT_ATTR}].lucid-hover {
  outline: 2px solid #2563eb !important;
  outline-offset: 1px !important;
  cursor: pointer !important;
}
[${ELEMENT_ATTR}].lucid-selected {
  outline: 2px solid #b45309 !important;
  outline-offset: 1px !important;
  background: rgba(251, 191, 36, 0.22) !important;
}
`;

/** The injected script, as source. It runs inside the frame, where lucid's
 * own code cannot otherwise go. */
const script = (artifactId: string, version: number): string => `
(function () {
  var SOURCE = ${JSON.stringify(FRAME_MESSAGE_SOURCE)};
  var ATTR = ${JSON.stringify(ELEMENT_ATTR)};
  var ARTIFACT = ${JSON.stringify(artifactId)};
  var VERSION = ${JSON.stringify(version)};

  // An id per element, in document order. Assigned by lucid rather than
  // taken from the document: an agent-written id may be missing, repeated,
  // or different in the next version, and none of those can be an address.
  var n = 0;
  var all = document.body ? document.body.querySelectorAll("*") : [];
  for (var i = 0; i < all.length; i++) all[i].setAttribute(ATTR, "e" + ++n);

  var selected = [];
  var hovered = null;

  var post = function () {
    parent.postMessage(
      { source: SOURCE, kind: "selection", artifactId: ARTIFACT, version: VERSION, ids: selected.slice() },
      "*"
    );
  };

  var addressable = function (node) {
    if (!node || node.nodeType !== 1) return null;
    return node.hasAttribute(ATTR) ? node : null;
  };

  var paint = function () {
    var marked = document.querySelectorAll(".lucid-selected");
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove("lucid-selected");
    for (var j = 0; j < selected.length; j++) {
      var el = document.querySelector("[" + ATTR + '="' + selected[j] + '"]');
      if (el) el.classList.add("lucid-selected");
    }
  };

  // Capture phase, and nothing is cancelled: the document's own listeners
  // see every event exactly as they would with lucid absent.
  document.addEventListener("mouseover", function (e) {
    if (!e.isTrusted) return;
    var el = addressable(e.target);
    if (el === hovered) return;
    if (hovered) hovered.classList.remove("lucid-hover");
    hovered = el;
    if (hovered) hovered.classList.add("lucid-hover");
  }, true);

  document.addEventListener("mouseout", function (e) {
    if (!e.isTrusted) return;
    if (hovered) { hovered.classList.remove("lucid-hover"); hovered = null; }
  }, true);

  document.addEventListener("click", function (e) {
    // A document that dispatches its own click is doing its own work.
    if (!e.isTrusted) return;
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
    if (!e.isTrusted) return;
    if (addressable(e.target)) return;
    if (selected.length === 0) return;
    selected = [];
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
export const instrumentArtifact = (bytes: string, artifactId: string, version: number): string => {
  const added = `<style data-lucid="1">${STYLE}</style><script data-lucid="1">${script(artifactId, version)}</script>`;
  const close = bytes.lastIndexOf("</body>");
  if (close === -1) return `${bytes}${added}`;
  return `${bytes.slice(0, close)}${added}${bytes.slice(close)}`;
};
