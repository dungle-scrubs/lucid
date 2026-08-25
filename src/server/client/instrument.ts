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

/** Who wrote the content in an element. Set on every element when the
 * document is instrumented, from the version's own author, so a spot can
 * say who wrote it. Editing (a later slice) changes it per element, which
 * is why it lives on the element rather than on the version. */
export const AUTHOR_ATTR = "data-lucid-author";

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
[${ELEMENT_ATTR}].lucid-edited {
  outline: 2px solid #0d9488 !important;
  outline-offset: 1px !important;
}
[${ELEMENT_ATTR}][contenteditable="true"] {
  outline: 2px solid #0d9488 !important;
  outline-offset: 1px !important;
  background: rgba(13, 148, 136, 0.10) !important;
}
[${ELEMENT_ATTR}].lucid-noted {
  outline: 2px dashed #7c3aed !important;
  outline-offset: 1px !important;
  background: rgba(167, 139, 250, 0.16) !important;
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
  var dirty = false;

  var CONTROL = "input,textarea,select";

  // A control the agent authored is addressed by lucid's element id, so a
  // value survives a document whose own ids are absent or repeated.
  var readValues = function () {
    var out = {};
    var els = document.querySelectorAll(CONTROL);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute(ATTR);
      if (!key) continue;
      if (el.type === "checkbox" || el.type === "radio") out[key] = el.checked ? "on" : "";
      else out[key] = String(el.value == null ? "" : el.value);
    }
    return out;
  };

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
      m.removeAttribute("contenteditable");
      m.classList.remove("lucid-hover", "lucid-selected", "lucid-noted", "lucid-edited");
      if (m.getAttribute("class") === "") m.removeAttribute("class");
    }
    return "<!doctype html>" + copy.outerHTML;
  };

  // Editing prose: a document is not editable until asked. Double-click
  // opens the element under the pointer; leaving it closes it. The element
  // is then authored by the person, which is what per-spot provenance
  // reads.
  document.addEventListener("dblclick", function (e) {
    if (!e.isTrusted) return;
    var el = addressable(e.target);
    if (!el || el.matches(CONTROL)) return;
    el.setAttribute("contenteditable", "true");
    el.focus();
  }, true);

  document.addEventListener("focusout", function (e) {
    if (!e.isTrusted) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el.getAttribute("contenteditable") !== "true") return;
    el.removeAttribute("contenteditable");
  }, true);

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
        spots.push({
          id: String(m.ids[k]),
          // What was on screen, not the markup: the person marked what they
          // could read.
          snippet: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(),
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

    if (m.kind === "mark" && Array.isArray(m.ids)) {
      var noted = document.querySelectorAll(".lucid-noted");
      for (var a = 0; a < noted.length; a++) noted[a].classList.remove("lucid-noted");
      for (var b = 0; b < m.ids.length; b++) {
        var mel = document.querySelector("[" + ATTR + '="' + String(m.ids[b]) + '"]');
        if (mel) mel.classList.add("lucid-noted");
      }
      return;
    }
  });

  var touched = function (el) {
    if (!el || el.nodeType !== 1 || !el.hasAttribute(ATTR)) return;
    el.setAttribute(AUTHOR_ATTR, "human");
    el.classList.add("lucid-edited");
    if (!dirty) {
      dirty = true;
      parent.postMessage(
        { source: SOURCE, kind: "dirty", artifactId: ARTIFACT, version: VERSION },
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
