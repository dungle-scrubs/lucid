import type { FrameLocator } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Suite Q: the hostile artifact corpus (D-017).
 *
 * Twelve documents, each one hostile in a way REAL generated artifacts are -
 * not synthetic worst cases, but the shapes an LLM or an exporter actually
 * emits: its own CSP, handlers that swallow events, a competing overlay,
 * shadow roots, five megabytes of nodes, markup the parser has to repair, a
 * `<base>` that re-roots every URL, a document that rewrites itself, CSS
 * that lives in a file, no `<body>` at all, scripts that throw, and the same
 * id stamped on four siblings.
 *
 * Each fixture names the SEAM it attacks, because the corpus was designed
 * from the product's own mechanics, not from a list of scary words:
 * `src/server/inject.ts` anchors the overlay bootstrap on the raw text `</body>`; the
 * surface iframe is sandboxed `allow-scripts` only, so every stylesheet is
 * cross-origin to the document reading it (D-032); anchors fingerprint
 * elements with no shadow traversal; the static-asset route serves siblings
 * from the artifact's own directory.
 *
 * The parameterised test in `hostile.e2e.ts` drives every fixture through
 * the one loop that matters - pick, note, queue, send, `wait` receives the
 * right target and text - and a fixture that cannot survive that loop is a
 * recorded product defect, never a silently skipped row.
 */
export interface HostileFixture {
  /** Catalogue scenario id (suite Q). */
  readonly id: string;
  /** The Playwright test title fragment - what the document does to tooling. */
  readonly title: string;
  readonly html: string;
  /** Files written beside the artifact before `open` - the static-asset route
   *  serves them from the artifact's directory. */
  readonly siblings?: readonly { readonly name: string; readonly content: string }[];
  /** The element the test picks, in the artifact's own vocabulary. */
  readonly pick: string;
  /** Text the delivered annotation's note rides with; unique per fixture so a
   *  cross-wired delivery cannot pass. */
  readonly note: string;
  /** Text of the picked element - the human-readable proof the anchor grabbed
   *  the right spot (asserted on the snippet where the pipeline exposes it). */
  readonly picked: string;
  /** Wait for the document's own hostile behaviour to finish, so the pick is
   *  a statement about the settled document rather than a race with it. */
  readonly settle?: (surface: FrameLocator) => Promise<void>;
  /** Prove the fixture's hostile ingredient is actually PRESENT before the
   *  loop runs - a linked sheet that 404'd would leave the document benign
   *  and the loop green while the fixture stopped attacking its seam. */
  readonly proof?: (surface: FrameLocator) => Promise<void>;
}

/**
 * Fixtures the product cannot survive TODAY, each with the plan-ledger
 * finding that records exactly what was measured and what is wanted. The
 * corpus keeps them - deleting a fixture because it fails would be the
 * ledger lying by omission - and `hostile.e2e.ts` refuses to run a corpus
 * whose every member is not accounted for on one side or the other.
 *
 * When a fix lands, its id moves out of this map and the fixture joins the
 * loop; the guard test makes forgetting that move impossible.
 */
export const HOSTILE_DEFECTS: ReadonlyMap<string, string> = new Map([
  [
    "hostile-base-tag",
    "finding #45: a foreign <base> re-roots the path-absolute bootstrap src to the hostile origin",
  ],
  [
    "hostile-self-rewriting",
    "finding #47: the rewritten DOM exists only in the browser - resolution falls through positionally onto the SAVED skeleton, so resolved:true delivers context the human never saw",
  ],
]);

const page = (head: string, body: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Hostile artifact</title>
${head}
</head>
<body>
${body}
</body>
</html>`;

/** 18,000 flat sibling list items (~3.96MB as authored). Built once at
 *  module load; the constant is the fixture, same as PLAN_V1. The hostile
 *  dimension is the SIBLING FAN-OUT, not the byte count - see D-065. */
const HUGE_BODY = (() => {
  const filler =
    "The reconciliation pass compares the ledger row against the event stream and flags any divergence for the nightly audit, which is the only consumer allowed to write corrections back. ";
  const items: string[] = [];
  for (let i = 0; i < 18_000; i++) {
    items.push(`<li data-row="${i}">Row ${i}: ${filler}</li>`);
  }
  return items.join("\n");
})();

export const HOSTILE_FIXTURES: readonly HostileFixture[] = [
  {
    id: "hostile-csp-meta",
    title: "an artifact carrying its own CSP meta",
    // `default-src 'none'` is what a security-conscious generator emits. The
    // seam: the overlay bootstrap is an injected <script type="module"> - a
    // document-authored CSP that blocks scripts blocks the review tooling.
    html: page(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />`,
      `<article>
    <h1>Locked-down deployment plan</h1>
    <p id="claim">The freeze window opens Friday at 18:00 UTC.</p>
  </article>`,
    ),
    pick: "#claim",
    note: "Who signed off on the Friday window?",
    picked: "freeze window opens Friday",
  },
  {
    id: "hostile-prevent-default",
    title: "an artifact whose capture-phase handlers swallow every event",
    // The seam: the overlay picks via its own listeners; a document that
    // calls preventDefault + stopPropagation at the capture phase on window
    // is fighting for the same events.
    html: page(
      "",
      `<article>
    <h1>Interactive checklist</h1>
    <p id="claim">Rollback rehearsal happens before the cutover, not after.</p>
  </article>
  <script>
    for (const type of ["pointerdown", "mousedown", "click", "mouseup"]) {
      window.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); }, true);
    }
  </script>`,
    ),
    pick: "#claim",
    note: "Schedule the rehearsal explicitly.",
    picked: "Rollback rehearsal happens before",
  },
  {
    id: "hostile-competing-overlay",
    title: "an artifact with its own full-width overlay at maximum z-index",
    // The banner out-bids the overlay host's z-index 2147483646 by one, and
    // the loop is proved on content BESIDE it. What this fixture does NOT
    // measure - deliberately, recorded as finding #48 - is the mark-under-
    // banner stacking contest; that needs its own fixture with a scroll and
    // an overlay settle.
    html: page(
      "",
      `<div style="position:fixed;top:0;left:0;right:0;height:30vh;background:rgba(20,20,28,0.9);color:#fff;z-index:2147483647;display:flex;align-items:center;justify-content:center">
    This banner is part of the artifact and will not move.
  </div>
  <article style="margin-top:35vh">
    <h1>Consent flow</h1>
    <p id="claim">The banner must never cover the primary action.</p>
  </article>`,
    ),
    pick: "#claim",
    note: "The banner contradicts this claim on mobile.",
    picked: "banner must never cover",
  },
  {
    id: "hostile-shadow-dom",
    title: "an artifact whose content lives inside an open shadow root",
    // The seam: anchors have no shadow traversal - event targets inside a
    // shadow root retarget to the HOST at the document boundary. Picking
    // "inside" the component must anchor SOMETHING stable, not throw.
    html: page(
      "",
      `<article>
    <h1>Component gallery</h1>
    <widget-card id="card"></widget-card>
  </article>
  <script>
    customElements.define("widget-card", class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = '<div style="padding:12px;border:1px solid #999">' +
          '<p>The card renders its own padding from shadow styles.</p></div>';
      }
    });
  </script>`,
    ),
    pick: "#card",
    note: "Does the padding come from the theme or the component?",
    // The snippet pins the PICK to the retargeted host - measured: the anchor
    // captures <widget-card>, which is the stable thing the document offers.
    picked: "<widget-card",
  },
  {
    id: "hostile-huge-dom",
    title: "an artifact with eighteen thousand sibling nodes",
    // The seam: resolveElementAnchor fingerprints every element, and
    // indexAmongSiblings makes that super-quadratic over flat lists (D-065).
    // 18k rows is a real generated report, not a pathological one.
    html: page(
      "",
      `<article>
    <h1>Reconciliation report</h1>
    <p id="claim">Row 17442 diverged twice in one audit window.</p>
    <ol id="rows">
${HUGE_BODY}
    </ol>
  </article>`,
    ),
    pick: "#claim",
    note: "Pull the two divergence events for row 17442.",
    picked: "Row 17442 diverged twice",
  },
  {
    id: "hostile-malformed",
    title: "an artifact the parser has to repair, holding a literal </body> in a textarea",
    // TWO seams. The parser repairs unclosed and misnested tags - anchors
    // must hold on the REPAIRED tree. And `inject.ts` anchors the overlay
    // bootstrap on the first raw `</body>` in the SOURCE TEXT - which here
    // is inside a <textarea>, where the parser treats it as text. Injecting
    // there would render the bootstrap as visible textarea content and never
    // boot the overlay.
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Hostile artifact</title></head>
<body>
  <article>
    <h1>Form draft<b> with an unclosed bold
    <p id="claim">The export template still references </td> cells that were removed.
    <div>
      <textarea rows="3" cols="40">Paste the closing tags here: </body> and </html> belong at the end.</textarea>
  </article>
</body>
</html>`,
    pick: "#claim",
    note: "Delete the stale cell references from the template.",
    picked: "export template still references",
  },
  {
    id: "hostile-base-tag",
    title: "an artifact whose <base> re-roots every URL to a foreign origin",
    // The seam: the injected bootstrap loads `${base}/__lucid/client.js` as a
    // path-absolute URL, and a document <base> re-roots path-absolute URLs to
    // ITS origin - the overlay module would be fetched from the foreign host.
    html: page(
      `<base href="https://hostile.invalid/exports/" />`,
      `<article>
    <h1>Exported summary</h1>
    <p id="claim">Every relative link in this export points at the vendor portal.</p>
  </article>`,
    ),
    pick: "#claim",
    note: "The links must survive offline reading too.",
    picked: "relative link in this export",
  },
  {
    id: "hostile-self-rewriting",
    title: "an artifact that rewrites its own DOM after load",
    // The seam: anchors captured against a document that no longer exists,
    // and a live-reload path watching a document that changes itself. The
    // pick happens AFTER the rewrite settles, which is what a human does.
    html: page(
      "",
      `<article id="app">
    <h1>Loading skeleton</h1>
    <p>Rendering…</p>
  </article>
  <script>
    setTimeout(() => {
      document.getElementById("app").innerHTML =
        '<h1>Hydrated dashboard</h1>' +
        '<p id="claim">The hydrated view replaces the skeleton after 300ms.</p>';
    }, 300);
  </script>`,
    ),
    pick: "#claim",
    note: "Announce the swap to screen readers.",
    picked: "hydrated view replaces the skeleton",
    settle: async (surface) => {
      await expect(surface.locator("#claim")).toBeVisible();
    },
  },
  {
    id: "hostile-linked-stylesheet",
    title: "an artifact whose CSS lives in a linked file",
    // The D-032 seam: the surface iframe has no allow-same-origin, so the
    // document's origin is opaque and EVERY stylesheet is cross-origin to
    // it - `cssRules` throws for the linked sheet, and anything reading
    // `document.styleSheets` (the theme-capability walk) must survive that
    // without relabelling or crashing. The sibling file is served by the
    // session's own static-asset route.
    html: page(
      `<link rel="stylesheet" href="style.css" />`,
      `<article>
    <h1>Styled from a file</h1>
    <p id="claim">The accent color for this document is defined in style.css.</p>
  </article>`,
    ),
    siblings: [
      {
        name: "style.css",
        content: `:root { --paper: #ffffff; --ink: #101418; --accent: #2b6cb0; }
body { background: var(--paper); color: var(--ink); font-family: system-ui; max-width: 720px; margin: 40px auto; }
h1 { color: var(--accent); }`,
      },
    ],
    pick: "#claim",
    note: "Inline the tokens so the doc survives being emailed.",
    picked: "accent color for this document",
    // The seam must be PRESENT to be survived: unstyled, this document is
    // benign and the loop would pass while measuring nothing. Proved by the
    // body max-width, which only the linked sheet sets - NOT by the accent
    // color, which Lucid's theme layer deliberately remaps (asserting the
    // authored hex measured the absence of the very remapping D-032 is
    // about; observed rgb(123,98,40) where the sheet says #2b6cb0).
    proof: async (surface) => {
      await expect(surface.locator("body")).toHaveCSS("max-width", "720px");
    },
  },
  {
    id: "hostile-fragment-only",
    title: "an artifact that is a bare fragment - no html, head, or body tags",
    // The seam: inject.ts's append branch (no </body>, no </html>), and the
    // payload builder's fragment wrapping. Generators emit exactly this.
    html: `<article>
  <h1>Pasted fragment</h1>
  <p id="claim">This document was saved without any of its wrapper tags.</p>
</article>`,
    pick: "#claim",
    note: "Wrap the export before publishing it.",
    picked: "saved without any of its wrapper",
  },
  {
    id: "hostile-throwing-script",
    title: "an artifact whose own scripts throw, at load and on every click",
    // The seam: the overlay shares the document's error channel. The click
    // handler is registered at WINDOW CAPTURE - the one phase that runs
    // BEFORE the overlay's document-capture pick listener - so the throw
    // genuinely interleaves with every pick (a bubble-phase handler would
    // never run: the overlay stops propagation on a successful pick). An
    // exception in one listener must not stop the others.
    html: page(
      "",
      `<article>
    <h1>Broken embed</h1>
    <p id="claim">The chart library fails to initialise in this export.</p>
  </article>
  <script>
    window.addEventListener("click", () => { throw new Error("artifact click handler exploded"); }, true);
    throw new Error("artifact load exploded");
  </script>`,
    ),
    pick: "#claim",
    note: "Ship the fallback table when the chart dies.",
    picked: "chart library fails to initialise",
  },
  {
    id: "hostile-duplicate-ids",
    title: "an artifact stamping one data-lucid-id on four identical siblings",
    // The 9df5eae seam at authoring scale: a generator that reuses an anchor
    // id. Picking the THIRD must deliver an annotation that resolves to the
    // third, not the first - the ambiguous-fingerprint disambiguation working
    // against an author actively making identity worse.
    html: page(
      "",
      `<article>
    <h1>Duplicated anchors</h1>
    <ul id="list">
      <li data-lucid-id="dup">The same generated row, verbatim.</li>
      <li data-lucid-id="dup">The same generated row, verbatim.</li>
      <li data-lucid-id="dup">The same generated row, verbatim.</li>
      <li data-lucid-id="dup">The same generated row, verbatim.</li>
    </ul>
  </article>`,
    ),
    pick: "#list li:nth-child(3)",
    note: "This third row specifically is the broken one.",
    picked: "same generated row",
  },
];
