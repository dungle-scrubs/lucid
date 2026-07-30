import { css, html, LitElement, type PropertyValues } from "lit";

import {
  type Anchor,
  captureDecision,
  captureElement,
  captureSelectionDecision,
  captureRangeAnchor,
  resolveElementInDocument,
  resolveRangeInDocument,
} from "../shared/capture.ts";
import {
  isChromeMessage,
  type ChromeMessage,
  type OverlayMessage,
  type PayloadAnnotationLike,
  type QueuedAnchorLike,
} from "../shared/protocol.ts";

/**
 * A stylesheet the overlay adds to the ARTIFACT's document, as a constructed
 * stylesheet rather than a `<style>` element (plan 04, #42).
 *
 * `style-src` governs style ELEMENTS; a constructed sheet adopted onto the
 * document is not subject to it at all. That is what lets Lucid keep its
 * hands off the artifact's own CSP: no style nonce to mint, nothing to append
 * to the author's `style-src`, and no way to nullify an `'unsafe-inline'`
 * they were relying on (a nonce in a source list makes the browser IGNORE
 * `'unsafe-inline'`, which would strip the styling off an ordinary
 * self-contained artifact).
 *
 * Keyed by id so each sheet is adopted once and can be dropped again, the
 * same contract the `<style id=…>` elements had.
 */
const adopted = new Map<string, CSSStyleSheet>();

const adoptStyle = (id: string, cssText: string): void => {
  if (adopted.has(id)) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cssText);
  adopted.set(id, sheet);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
};

const dropStyle = (id: string): void => {
  const sheet = adopted.get(id);
  if (!sheet) return;
  adopted.delete(id);
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
};

const OVERLAY_ROOT_ID = "__lucid_overlay_root";
const INTERACTIVE =
  "a, button, input, select, textarea, label, [contenteditable], [role=button], summary";

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

type MarkerState = "committed" | "queued" | "pending";

/** Id prefix of the in-flight (pending) composer anchor markers - one per
 *  collected spot, suffixed by position. */
const PENDING_ID = "__lucid_pending";

interface Marker {
  readonly id: string;
  /** Lifecycle state of the annotation this marker anchors; drives its style. */
  readonly state: MarkerState;
  /** 1-based number shared with the left-panel card; 0 = no badge (a pending
   *  spot, or a multi-target item's secondary spots). */
  readonly index: number;
  readonly rects: readonly Rect[];
  /** How many earlier badges land on this same corner. Annotating one element
   *  twice would otherwise stack badges exactly and hide all but the last, so
   *  each is stepped right into a cascade. */
  readonly stackIndex: number;
}

/** Horizontal step per cascaded badge - less than the badge width, so they
 *  overlap and read as a stack rather than a row. */
const BADGE_STEP_PX = 13;

/**
 * Merge a range's client rects into one box per visual line. `getClientRects()`
 * fragments at every inline-element boundary (each `<code>` chip), which would
 * otherwise draw a separate outline around every child; coalescing by line
 * yields a single outline per line (one box for a single-line selection).
 */
const coalesceByLine = (rects: readonly DOMRect[]): Rect[] => {
  const lines: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const r of rects) {
    if (r.width <= 0 || r.height <= 0) continue;
    const line = lines.find(
      (l) => Math.abs(l.top - r.top) < 4 && Math.abs(l.bottom - r.bottom) < 6,
    );
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return lines.map((l) => ({
    left: l.left,
    top: l.top,
    width: l.right - l.left,
    height: l.bottom - l.top,
  }));
};

const post = (message: OverlayMessage): void => window.parent.postMessage(message, "*");

/** The token sheet Lucid injects into the artifact. Named once because
 *  `canRenderDark` has to recognise and skip it: it declares the very tokens
 *  that check looks for. */
const THEME_STYLE_ID = "__lucid_theme_style";

/**
 * The overlay (RFC §1, §5). Injected into the artifact iframe, mounted once
 * into a persistent Shadow-DOM host. Provides hover targeting, click/alt-click
 * element annotation, text-range selection, committed-annotation highlights,
 * and the subtree-only live-reload swap (D-042).
 */
export class LucidOverlay extends LitElement {
  static properties = {
    markers: { state: true },
    hoverRect: { state: true },
    focusedId: { state: true },
  };

  declare markers: Marker[];
  declare hoverRect: DOMRect | null;
  declare focusedId: string | null;

  private committed: PayloadAnnotationLike[] = [];
  private queuedAnchors: QueuedAnchorLike[] = [];
  private pendingAnchors: readonly Anchor[] = [];
  /** Read mode when false: no marks painted, no targeting. The chrome owns this
   *  and restates it on every highlight, so the two can never drift. */
  private showTargets = true;
  private hoverAnnotationId: string | null = null;
  private lastMouse: { x: number; y: number } | null = null;
  private rafPending = false;
  private readonly onScroll = (): void => this.scheduleReposition();
  private readonly onResize = (): void => this.scheduleReposition();

  constructor() {
    super();
    this.markers = [];
    this.hoverRect = null;
    this.focusedId = null;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
      font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    /* The overlay lives in a shadow root inside the artifact's own document, so
       the chrome's stylesheet never reaches it - it kept animating while the
       rest of the product had stopped. The accessibility preference is the
       artifact reader's too, and a mark that is still easing when a measurement
       is taken is a position nothing was ever at. */
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
    .hover {
      position: fixed;
      border: 1.5px dashed rgba(94, 129, 172, 0.9);
      background: rgba(94, 129, 172, 0.08);
      pointer-events: none;
      transition: all 0.04s linear;
    }
    .marker {
      position: fixed;
      pointer-events: none;
      box-sizing: border-box;
      transition: background 0.1s linear, box-shadow 0.1s linear;
    }
    /* Nord frost carries the mark language on the paper (matching the chrome's
       SMUI theme): committed = sent (frost solid); queued = composed-but-unsent
       (frost dashed); pending = the anchor being composed right now (Nord
       purple - active, distinct from the frost of settled marks). */
    .marker.committed {
      background: rgba(136, 192, 208, 0.22);
      border: 1.5px solid rgba(94, 129, 172, 0.85);
      box-shadow: 0 0 0 1px rgba(94, 129, 172, 0.22);
    }
    .marker.queued {
      background: rgba(136, 192, 208, 0.12);
      border: 1.5px dashed rgba(129, 161, 193, 0.9);
    }
    .marker.pending {
      background: rgba(180, 142, 173, 0.16);
      border: 1.5px solid rgba(180, 142, 173, 0.95);
      box-shadow: 0 0 0 2px rgba(180, 142, 173, 0.22);
    }
    .marker.focused {
      background: rgba(136, 192, 208, 0.45);
      box-shadow: 0 0 0 2px rgba(94, 129, 172, 0.55);
    }
    .badge {
      position: fixed;
      /* Centred on the anchor's top-left corner, so it straddles the edge. */
      transform: translate(-50%, -50%);
      width: 20px;
      height: 20px;
      /* The ONE rounded thing in the interface, and deliberately so: everything
         else is square, so a circle reads as a different KIND of object - a
         marker pinned onto the document rather than a piece of the chrome. */
      border-radius: 9999px;
      color: #1a202c;
      font-size: 11px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    }
    .badge.committed {
      background: rgba(129, 161, 193, 0.97);
    }
    .badge.queued {
      background: rgba(136, 192, 208, 0.95);
      border: 1px dashed rgba(76, 104, 140, 0.7);
    }
    .badge.focused {
      box-shadow: 0 0 0 3px rgba(94, 129, 172, 0.5);
      filter: brightness(1.08);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    // Picking listens at WINDOW capture, not document (plan 04, M2.2, #43):
    // the capture path runs window -> document -> target, so an artifact that
    // registers window-capture handlers calling stopPropagation starves any
    // document-level listener - while listeners on the SAME target all run
    // regardless of stopPropagation (only stopImmediatePropagation silences
    // co-target listeners, and an artifact hostile enough for that has taken
    // the page from every tool). Same events, same targets, one rung higher.
    window.addEventListener("mousemove", this.onMouseMove, true);
    window.addEventListener("mousedown", this.onMouseDown, true);
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("mouseup", this.onMouseUp, true);
    document.addEventListener("mouseleave", this.onMouseLeaveDoc);
    window.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    window.addEventListener("resize", this.onResize, { passive: true });
    window.addEventListener("message", this.onMessage);
    post({ source: "lucid-overlay", type: "ready" });
    this.publishSectionIds();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("mousemove", this.onMouseMove, true);
    window.removeEventListener("mousedown", this.onMouseDown, true);
    window.removeEventListener("click", this.onClick, true);
    window.removeEventListener("mouseup", this.onMouseUp, true);
    document.removeEventListener("mouseleave", this.onMouseLeaveDoc);
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("message", this.onMessage);
  }

  private isOwn(el: EventTarget | null): boolean {
    if (!(el instanceof Element)) return true;
    return (
      el.id === OVERLAY_ROOT_ID ||
      el.closest(`#${OVERLAY_ROOT_ID}`) !== null ||
      el.hasAttribute("data-lucid-ignore")
    );
  }

  /**
   * Page-level containers (`<html>`, `<body>`) are never annotation targets:
   * they span the full viewport, so hovering the empty margins outside the
   * artifact's content column would otherwise highlight and annotate the whole
   * page. Targeting only fires on real content inside the body.
   */
  private isStructural(el: EventTarget | null): boolean {
    if (!(el instanceof Element)) return true;
    return (
      el === document.body ||
      el === document.documentElement ||
      el.tagName === "HTML" ||
      el.tagName === "BODY"
    );
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    this.lastMouse = { x: e.clientX, y: e.clientY };
    this.updateHover(e.target as Element | null, e.clientX, e.clientY);
  };

  /** Recompute the hover outline + reverse-highlight for a cursor position. */
  private updateHover(target: Element | null, x: number, y: number): void {
    if (!this.showTargets) return; // read mode: no hover outline, no reverse-highlight
    if (!target || this.isOwn(target) || this.isStructural(target)) {
      this.hoverRect = null;
    } else {
      this.hoverRect = target.getBoundingClientRect();
    }
    const hit = this.annotationAt(x, y);
    if (hit !== this.hoverAnnotationId) {
      this.hoverAnnotationId = hit;
      this.focusedId = hit;
      post({ source: "lucid-overlay", type: "annotation-hover", id: hit });
    }
  }

  /** On scroll, the cursor is stationary but the element under it changed, so
   *  re-derive the hover from the last known pointer position. */
  private refreshHoverFromLastMouse(): void {
    const m = this.lastMouse;
    if (!m) {
      this.hoverRect = null;
      return;
    }
    this.updateHover(document.elementFromPoint(m.x, m.y), m.x, m.y);
  }

  private readonly onMouseLeaveDoc = (): void => {
    this.lastMouse = null;
    this.hoverRect = null;
    if (this.hoverAnnotationId !== null) {
      this.hoverAnnotationId = null;
      this.focusedId = null;
      post({ source: "lucid-overlay", type: "annotation-hover", id: null });
    }
  };

  // ---- diff view (RFC §8) ---------------------------------------------------

  /**
   * The human's palette choice, applied to the artifact document.
   *
   * Two parts: an attribute on `<html>`, and a stylesheet that remaps the six
   * standard design-system tokens for each theme. The attribute selector
   * (`:root[data-lucid-theme=…]`) outranks both the artifact's own `:root`
   * block and its `@media (prefers-color-scheme: dark)` remap - a media query
   * carries no specificity of its own - so the choice holds even on an artifact
   * written before Lucid had a toggle, and even when it disagrees with the OS.
   *
   * Only the standard tokens are declared. An artifact's own extra variables,
   * and anything it derives from these, follow automatically.
   */
  private applyTheme(theme: "light" | "dark"): void {
    // An artifact with NO dark form must not be forced into one. Declaring
    // `color-scheme: dark` flips the browser's own canvas to near-black while
    // the document's hardcoded ink stays dark - dark text on a dark ground,
    // which is worse than the light page the author actually designed.
    const wanted = theme === "dark" && !this.canRenderDark() ? "light" : theme;
    document.documentElement.dataset.lucidTheme = wanted;
    this.retuneColorSchemeQueries(wanted);
    adoptStyle(
      THEME_STYLE_ID,
      `
      :root[data-lucid-theme="light"] {
        --paper: #faf6ec;
        --ink: #211d15;
        --ink-muted: #5e6773;
        --rule: rgba(33, 29, 21, 0.12);
        --accent: #7b6228;
        --accent-wash: rgba(203, 168, 90, 0.16);
        color-scheme: light;
      }
      :root[data-lucid-theme="dark"] {
        --paper: #211d15;
        --ink: #ece3cf;
        --ink-muted: #a89d84;
        --rule: rgba(236, 227, 207, 0.14);
        --accent: #d9bd7a;
        --accent-wash: rgba(203, 168, 90, 0.18);
        color-scheme: dark;
      }
    `,
    );
  }

  /**
   * Can this document be rendered dark at all?
   *
   * Two ways to qualify: it routes colour through the standard tokens (so
   * Lucid's injected dark values reach it), or it ships its own
   * `prefers-color-scheme` block (so retuning the query reaches it). An
   * artifact with neither has exactly one appearance, and honouring that is
   * more useful than a dark rectangle full of invisible text.
   *
   * The question is about the artifact AS ITS AUTHOR WROTE IT, and both halves
   * used to answer with Lucid's own work instead:
   *
   * - `getComputedStyle(:root).--paper` sees the token sheet `applyTheme`
   *   injects, whose `:root[data-lucid-theme="light"]` block declares `--paper`
   *   and `--ink`. From the second theme message onward every artifact declared
   *   the tokens, so every artifact was dark-capable and this check stopped
   *   meaning anything.
   * - `rule.conditionText` is REWRITTEN by `retuneColorSchemeQueries`, to
   *   `(min-width: 0px)` or `(max-width: 0px)`. After the first theme message no
   *   rule mentions `prefers-color-scheme` at all, so an artifact that qualified
   *   only on its own dark block stopped qualifying. `schemeQueries` keeps the
   *   original condition and is the only trustworthy source from then on.
   *
   * Measured fresh on every call, never memoized: `markOverlayReady` fires both
   * on the overlay's `ready` message and on the iframe's `load`, so a `<link>`
   * sheet can land BETWEEN two theme messages. Freezing the first answer would
   * lock such an artifact out of dark with no way back.
   */
  private canRenderDark(): boolean {
    return this.cascadeDeclaresTokens() || this.carriesOwnDarkForm();
  }

  /**
   * Does the artifact route colour through the standard tokens?
   *
   * Asked of the RESOLVED cascade, because a rule walk cannot answer it. The
   * artifact frame is sandboxed without `allow-same-origin` (Chrome.tsx), so it
   * runs on an opaque origin - which is cross-origin with its own server. Every
   * `<link>`ed sheet therefore throws `SecurityError` on `cssRules`, and a walk
   * would conclude "no tokens" for the entire class of artifact that keeps its
   * CSS in a file. Their tokens resolve perfectly well; they are simply not
   * readable rule by rule.
   *
   * Lucid's own tokens are excluded by un-matching them rather than by skipping
   * a sheet: `:root[data-lucid-theme=…]` is the only selector its injected sheet
   * uses, so with the attribute absent its declarations cannot apply. Removed
   * and restored inside one task, so nothing can paint in between.
   */
  private cascadeDeclaresTokens(): boolean {
    const root = document.documentElement;
    const previous = root.dataset.lucidTheme;
    delete root.dataset.lucidTheme;
    try {
      const own = getComputedStyle(root);
      return (
        own.getPropertyValue("--paper").trim() !== "" || own.getPropertyValue("--ink").trim() !== ""
      );
    } finally {
      if (previous !== undefined) root.dataset.lucidTheme = previous;
    }
  }

  /**
   * Does the artifact ship a dark form of its own - a `prefers-color-scheme`
   * block Lucid can retune, or a rule keyed on the attribute Lucid sets?
   *
   * This one needs the rules: no computed value reveals that a document has a
   * dark variant it is not currently showing. Sheets the sandbox makes
   * unreadable are skipped, which is the right direction here - an unreadable
   * dark block cannot be retuned either, so it would keep following the OS
   * rather than the reader, and claiming it as a dark form would be a lie.
   */
  private carriesOwnDarkForm(): boolean {
    const qualifies = (rules: CSSRuleList): boolean => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) {
          const original = this.schemeQueries.get(rule) ?? rule.conditionText;
          if (/prefers-color-scheme/i.test(original)) return true;
        }
        // An artifact may key its own dark form off the attribute Lucid sets.
        // `themeReadiness` in src/core/theme.ts already counts that as a dark
        // form when it warns the author, so the viewer has to agree with it -
        // otherwise `lucid open` stays silent and the artifact is then refused.
        if (
          rule instanceof CSSStyleRule &&
          /data-lucid-theme\s*=\s*["']?dark/i.test(rule.selectorText)
        ) {
          return true;
        }
        // `@import` hides a whole sheet behind a single rule. Every other
        // grouping at-rule - @media, @supports, @layer, @container, @scope, and
        // CSS nesting - just exposes `cssRules`, so duck-typing covers the ones
        // not invented yet rather than an allowlist that silently misses them.
        if (rule instanceof CSSImportRule) {
          try {
            if (rule.styleSheet && qualifies(rule.styleSheet.cssRules)) return true;
          } catch {
            /* imported sheet unreadable from this origin */
          }
          continue;
        }
        const nested = (rule as Partial<CSSGroupingRule>).cssRules;
        if (nested && qualifies(nested)) return true;
      }
      return false;
    };

    for (const sheet of Array.from(document.styleSheets)) {
      // Every sheet Lucid injects, not just the token one: the diff and section
      // sheets carry hardcoded colours today, and the first person to tokenise
      // them would otherwise reinstate exactly the bug this method exists to fix.
      if ((sheet.ownerNode as Element | null)?.id?.startsWith("__lucid_")) continue;
      try {
        if (qualifies(sheet.cssRules)) return true;
      } catch {
        /* opaque-origin or cross-origin sheet: unreadable from here */
      }
    }
    return false;
  }

  /** Each `prefers-color-scheme` media rule with its ORIGINAL condition, so
   *  toggling back and forth stays lossless. */
  private schemeQueries = new WeakMap<CSSMediaRule, string>();

  /**
   * Hand the artifact's OWN dark block to the human instead of to the OS.
   *
   * Injecting the six standard tokens is not enough: a good artifact remaps a
   * dozen (`--surface`, `--sunken`, `--muted`, `--faint`…) inside
   * `@media (prefers-color-scheme: dark)`, and that query keeps matching on a
   * dark machine no matter what the reader picked. The result was the worst of
   * both - light paper with dark code chips, dark panels and pale grey body
   * text, all technically token-driven.
   *
   * So the color-scheme FEATURE is rewritten to a condition that is simply true
   * or false: `(min-width: 0px)` / `(max-width: 0px)`. Only that feature is
   * touched, so `(prefers-color-scheme: dark) and (min-width: 60em)` keeps its
   * width test. Nothing about the artifact's own CSS has to change, and an
   * artifact opened straight from disk still follows the OS as its author
   * intended - this only applies while Lucid is the one rendering it.
   */
  private retuneColorSchemeQueries(theme: "light" | "dark"): void {
    const rewrite = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) {
          const original = this.schemeQueries.get(rule) ?? rule.conditionText;
          if (/prefers-color-scheme/i.test(original)) {
            this.schemeQueries.set(rule, original);
            // A block written for the theme in force is switched ON, the other
            // OFF - whichever way round the author wrote it.
            const wantsDark = /dark/i.test(original);
            const on = wantsDark === (theme === "dark");
            try {
              rule.media.mediaText = original.replace(
                /\(\s*prefers-color-scheme\s*:\s*(?:dark|light)\s*\)/gi,
                on ? "(min-width: 0px)" : "(max-width: 0px)",
              );
            } catch {
              /* some engines refuse the write; the token floor still applies */
            }
          }
          rewrite(rule.cssRules);
          continue;
        }
        // An imported sheet is a whole stylesheet behind one rule, and its dark
        // block needs retuning like any other - left alone it keeps following
        // the OS after the reader has chosen. Everything else that can wrap a
        // color-scheme block (@supports, @layer, @container, @scope, nesting)
        // exposes `cssRules`, so duck-typing covers them without an allowlist
        // that quietly misses whatever CSS adds next. Kept in step with
        // `carriesOwnDarkForm`, which has to find exactly what this can retune.
        if (rule instanceof CSSImportRule) {
          try {
            if (rule.styleSheet) rewrite(rule.styleSheet.cssRules);
          } catch {
            /* imported sheet unreadable from this origin */
          }
          continue;
        }
        const nested = (rule as Partial<CSSGroupingRule>).cssRules;
        if (nested) rewrite(nested);
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        rewrite(sheet.cssRules);
      } catch {
        /* a sheet we may not read (cross-origin): nothing to retune */
      }
    }
  }

  /** Inject the redline stylesheet into the artifact realm (sage/rust/brass). */
  private injectDiffStyles(): void {
    adoptStyle(
      "__lucid_diff_style",
      `
      [data-diff="added"] { box-shadow: inset 3px 0 0 #8aa872; background: rgba(163,190,140,0.12); }
      [data-diff="changed"] { box-shadow: inset 3px 0 0 #a3be8c; }
      .lucid-diff-was, .lucid-diff-now { display: block; padding: 2px 6px; }
      .lucid-diff-was { text-decoration: line-through; opacity: 0.7; background: rgba(191,97,106,0.12); }
      .lucid-diff-now { margin-top: 3px; background: rgba(163,190,140,0.14); }
      .lucid-diff-was::before, .lucid-diff-now::before { display: block; font-size: 9px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; text-decoration: none; opacity: 0.8; }
      .lucid-diff-was::before { content: "was"; color: #bf616a; }
      .lucid-diff-now::before { content: "now"; color: #6f8d59; }
      .lucid-ghost { display: block; opacity: 0.55; text-decoration: line-through; background: rgba(191,97,106,0.08); box-shadow: inset 3px 0 0 #bf616a; }
      [data-hunk].lucid-active { outline: 2px solid #5e81ac; outline-offset: 3px; scroll-margin: 80px; }
    `,
    );
  }

  private removeDiffStyles(): void {
    dropStyle("__lucid_diff_style");
  }

  /** Injected once, survives artifact swaps (it lives in <head>, not the body
   *  the swap rebuilds). The outline fades to nothing so the emphasis is a
   *  glance, not a permanent mark on the artifact. */
  private injectSectionStyle(): void {
    adoptStyle(
      "__lucid_section_style",
      `
      @keyframes __lucid_section_flash { from { outline-color: rgba(94,129,172,0.9); } to { outline-color: rgba(94,129,172,0); } }
      .__lucid_section_target { outline: 2px solid rgba(94,129,172,0.9); outline-offset: 3px; scroll-margin: 80px; animation: __lucid_section_flash 1.6s ease-out forwards; }
    `,
    );
  }

  /** Scroll the artifact to a section by its `data-lucid-id` and flash it. The
   *  chat permalink's landing; a no-op if the id is gone (the chip that sent it
   *  should already have degraded to plain text from the published id set). */
  private revealSection(lucidId: string): void {
    this.injectSectionStyle();
    for (const el of document.querySelectorAll(".__lucid_section_target")) {
      el.classList.remove("__lucid_section_target");
    }
    // Match by attribute value rather than building a selector: an id with a
    // quote or control char could make querySelector throw instead of missing.
    const target = Array.from(document.querySelectorAll("[data-lucid-id]")).find(
      (el) => el.getAttribute("data-lucid-id") === lucidId,
    );
    if (!target) return;
    target.classList.add("__lucid_section_target");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /** Report every `data-lucid-id` in the artifact so the chrome can tell a live
   *  section permalink from a dead one without reaching into this opaque-origin
   *  DOM. Published on load and after every swap. */
  private publishSectionIds(): void {
    const ids = Array.from(document.querySelectorAll("[data-lucid-id]"))
      .map((el) => el.getAttribute("data-lucid-id"))
      .filter((id): id is string => id !== null && id !== "");
    post({ source: "lucid-overlay", type: "section-ids", ids: Array.from(new Set(ids)) });
  }

  /** Scroll to a hunk and emphasize it with the brass active outline. */
  private gotoHunk(hunkId: string): void {
    for (const el of document.querySelectorAll("[data-hunk].lucid-active")) {
      el.classList.remove("lucid-active");
    }
    const target = document.querySelector(`[data-hunk="${hunkId.replace(/[^\w-]/g, "")}"]`);
    if (!target) return;
    target.classList.add("lucid-active");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /** Light a mark and scroll the artifact to it - the keyboard "open" of a
   *  card whose mark may be far off-screen. Reuses the already-resolved marker
   *  rect (viewport-relative), so it lands wherever the anchor currently paints. */
  private revealAnnotation(id: string): void {
    this.focusedId = id;
    this.reposition();
    const m = this.markers.find((mk) => mk.id === id);
    const r = m?.rects[0];
    if (!r) return; // orphaned or unresolved: the focus glow is all there is to give
    const y = window.scrollY + r.top - window.innerHeight / 2 + r.height / 2;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }

  /** Topmost committed annotation whose outline contains the point, if any. */
  private annotationAt(x: number, y: number): string | null {
    const pad = 6;
    for (const m of this.markers) {
      if (m.state !== "committed") continue; // only sent annotations are hover-to-focus targets
      for (const r of m.rects) {
        if (
          x >= r.left - pad &&
          x <= r.left + r.width + pad &&
          y >= r.top - pad &&
          y <= r.top + r.height + pad
        ) {
          return m.id;
        }
      }
    }
    return null;
  }

  private readonly onClick = (e: MouseEvent): void => {
    // Read mode must return the document to normal: bail before the
    // preventDefault below, which would otherwise swallow links and controls.
    if (!this.showTargets) return;
    const target = e.target as Element | null;
    if (!target || this.isOwn(target) || this.isStructural(target)) return;
    // Clicking the content always starts a NEW annotation, even over a region
    // that already has one - re-annotating the same element is allowed. (To jump
    // to an existing annotation's card, click its ✎ badge or hover it.)
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return; // selection handled on mouseup
    const interactive = target.closest(INTERACTIVE) !== null;
    if (interactive && !e.altKey) return; // controls stay interactive (D-028)
    e.preventDefault();
    e.stopPropagation();
    const anchor = captureElement(target);
    const decision = captureDecision(target);
    post({
      source: "lucid-overlay",
      type: "target-picked",
      anchor,
      ...(decision ? { decision } : {}),
      // ctrl counts as meta, the chrome's own ⌘/ctrl equivalence: Meta is the
      // Super key on Windows/Linux, so metaKey alone would leave those viewers
      // with no collect gesture. No collision on macOS - ctrl-click fires
      // contextmenu there, never click.
      modifiers: { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey },
    });
  };

  /** The ✎ badge is the existing annotation's handle: click it to jump to its card. */
  private readonly onBadgeClick = (id: string, e: Event): void => {
    e.stopPropagation();
    post({ source: "lucid-overlay", type: "annotation-activate", id });
  };

  /** Where the press started, and whether a selection already existed there:
   *  a stationary shift-click over a LEFTOVER selection extends it natively,
   *  and the extended range would ride out as the pick - a spot the human
   *  never chose. Only a real drag may speak for a range. */
  private downAt: { x: number; y: number } | null = null;
  private hadSelectionAtDown = false;

  private readonly onMouseDown = (e: MouseEvent): void => {
    const sel = window.getSelection();
    this.hadSelectionAtDown = sel !== null && !sel.isCollapsed;
    this.downAt = { x: e.clientX, y: e.clientY };
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (!this.showTargets) return; // read mode: selecting text is just selecting text
    const stationary =
      this.downAt !== null && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 4;
    if (e.shiftKey && stationary && this.hadSelectionAtDown) {
      // Shift-click is the PIN gesture here, but the browser just extended the
      // leftover selection to the click point. Collapse it so the click
      // handler makes the element pick the human actually aimed at.
      window.getSelection()?.removeAllRanges();
      return;
    }
    const anchor = captureRangeAnchor();
    const decision = captureSelectionDecision();
    if (anchor)
      post({
        source: "lucid-overlay",
        type: "target-picked",
        anchor,
        ...(decision ? { decision } : {}),
        // ctrl-as-meta for the same reason as onClick above.
        modifiers: { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey },
      });
  };

  private readonly onMessage = (e: MessageEvent): void => {
    if (!isChromeMessage(e.data)) return;
    const msg = e.data as ChromeMessage;
    if (msg.type === "highlight") {
      this.committed = [...msg.annotations];
      this.queuedAnchors = [...msg.queued];
      this.pendingAnchors = msg.pendingList ?? (msg.pending ? [msg.pending] : []);
      this.showTargets = msg.showTargets;
      this.reposition();
    } else if (msg.type === "swap") {
      this.swapArtifact(msg.html);
    } else if (msg.type === "diff-show") {
      this.swapArtifact(msg.html);
      this.injectDiffStyles();
    } else if (msg.type === "diff-goto") {
      this.gotoHunk(msg.hunkId);
    } else if (msg.type === "focus-annotation") {
      // An empty id clears the focus (chrome card mouse-out).
      this.focusedId = msg.id || null;
      this.reposition();
    } else if (msg.type === "reveal-annotation") {
      this.revealAnnotation(msg.id);
    } else if (msg.type === "reveal-section") {
      this.revealSection(msg.lucidId);
    } else if (msg.type === "request-section-ids") {
      this.publishSectionIds();
    } else if (msg.type === "measure-content") {
      post({ source: "lucid-overlay", type: "content-width", width: this.measureContent() });
    } else if (msg.type === "ping") {
      // Inert by design - see the protocol. Answered from this same switch so
      // the reply proves everything queued before it has already been handled.
      post({ source: "lucid-overlay", type: "pong", nonce: msg.nonce });
    } else if (msg.type === "theme") {
      this.applyTheme(msg.theme);
    } else if (msg.type === "clear-pending") {
      this.focusedId = null;
    }
  };

  private scheduleReposition(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.reposition();
      this.refreshHoverFromLastMouse();
    });
  }

  /**
   * Re-resolve every painted anchor against the live DOM (D-029, D-041): sent
   * annotations (committed), composed-but-unsent queue items (queued), and the
   * one in-flight composer target (pending). Committed and queued carry a
   * 1-based number matching their left-panel card, so the link is visible at
   * rest, not only on hover.
   */
  private reposition(): void {
    if (!this.showTargets) {
      this.markers = [];
      this.hoverRect = null;
      return;
    }
    const markers: Omit<Marker, "stackIndex">[] = [];
    // A multi-spot item paints one marker PER target, all sharing the item's
    // id (so focus lights every spot), but only ONE carries the number - the
    // badge names the item, and numbering every spot would fake N items. The
    // badge goes to the first spot that still RESOLVES, not positionally to
    // targets[0]: a spot edited away drops out (the intended any-survives
    // degradation), and the item must keep its badge - it is the click-to-jump
    // handle and the card's number on the surface.
    const pushAll = (
      id: string,
      state: MarkerState,
      index: number,
      targets: readonly Anchor[],
    ): void => {
      let badged = false;
      for (const t of targets) {
        const rects = this.rectsFor(t);
        if (rects.length === 0) continue;
        markers.push({ id, state, index: badged ? 0 : index, rects });
        badged = true;
      }
    };
    let n = 0;
    for (const a of this.committed) {
      if (!a.resolved) continue; // orphaned annotations have no live anchor to paint
      n += 1; // per annotation, never per target: the badge matches the card's number
      pushAll(a.id, "committed", n, a.targets ?? [a.target]);
    }
    this.queuedAnchors.forEach((q, i) => {
      // CONTINUES the committed count, exactly as the panel's timeline does
      // (store.ts buildTimeline): a queued note is the next number, not a
      // second number 1. Restarting from `i + 1` put a queued mark wearing
      // "1" on the artifact while its own card correctly read "2".
      pushAll(q.id, "queued", n + i + 1, q.targets ?? [q.target]);
    });
    this.pendingAnchors.forEach((t, i) => {
      const rects = this.rectsFor(t);
      if (rects.length > 0)
        markers.push({ id: `${PENDING_ID}_${i}`, state: "pending", index: 0, rects });
    });
    // Two annotations on one element resolve to the same rect, so their badges
    // would sit exactly on top of each other. Count the earlier ones per corner
    // and let render step each into a cascade.
    const perCorner = new Map<string, number>();
    this.markers = markers.map((m) => {
      const r = m.rects[0];
      // Only badge-bearing markers join the cascade: an unnumbered secondary
      // spot draws no badge, so counting it would float a later badge off its
      // corner for a neighbour nobody can see.
      if (!r || m.index === 0) return { ...m, stackIndex: 0 };
      const corner = `${Math.round(r.left)}:${Math.round(r.top)}`;
      const stackIndex = perCorner.get(corner) ?? 0;
      perCorner.set(corner, stackIndex + 1);
      return { ...m, stackIndex };
    });
  }

  /** The widest real child of the body - what the chrome would measure itself
   *  if the sandbox let it reach in. Our own root and scripts do not count. */
  private measureContent(): number {
    let w = 0;
    for (const child of Array.from(document.body?.children ?? [])) {
      const el = child as HTMLElement;
      if (this.isOwn(el) || el.tagName === "SCRIPT") continue;
      w = Math.max(w, el.getBoundingClientRect().width);
    }
    return Math.round(w);
  }

  private rectsFor(target: Anchor): Rect[] {
    if (target.kind === "element") {
      const el = resolveElementInDocument(target);
      if (!el) return [];
      return [el.getBoundingClientRect()];
    }
    const range = resolveRangeInDocument(target);
    if (!range) return [];
    return coalesceByLine(Array.from(range.getClientRects()));
  }

  /**
   * Subtree-only swap (D-042): replace the artifact body nodes while preserving
   * the overlay host, then re-resolve anchors. Head <style>/<link> are synced.
   */
  private swapArtifact(htmlText: string): void {
    this.removeDiffStyles();
    const parsed = new DOMParser().parseFromString(htmlText, "text/html");
    const host = document.getElementById(OVERLAY_ROOT_ID);
    // Remove current artifact body nodes (everything except our host + scripts).
    const keep = new Set<Node>();
    if (host) keep.add(host);
    for (const s of document.body.querySelectorAll("script[src='/__lucid/client.js']")) keep.add(s);
    Array.from(document.body.childNodes).forEach((n) => {
      if (!keep.has(n)) document.body.removeChild(n);
    });
    // Insert new artifact body nodes before the host.
    const ref = host ?? null;
    Array.from(parsed.body.childNodes).forEach((n) => {
      if (
        n instanceof Element &&
        (n.id === OVERLAY_ROOT_ID || n.getAttribute("data-lucid-ignore") === "true")
      )
        return;
      if (n instanceof HTMLScriptElement && n.src.includes("/__lucid/client.js")) return;
      document.body.insertBefore(document.importNode(n, true), ref);
    });
    // Sync artifact <style> and <link rel="stylesheet"> tags from the new head.
    // Both are tagged so a later swap removes them; without carrying <link>s an
    // artifact that loads its CSS via <head> <link> would flash unstyled after a
    // version swap.
    for (const s of document.head.querySelectorAll("[data-lucid-artifact-style]")) s.remove();
    parsed.head.querySelectorAll("style").forEach((s) => {
      const clone = document.importNode(s, true);
      clone.setAttribute("data-lucid-artifact-style", "true");
      document.head.appendChild(clone);
    });
    parsed.head.querySelectorAll('link[rel="stylesheet"]').forEach((s) => {
      const clone = document.importNode(s, true);
      clone.setAttribute("data-lucid-artifact-style", "true");
      document.head.appendChild(clone);
    });
    this.scheduleReposition();
    this.publishSectionIds();
  }

  protected updated(_changed: PropertyValues): void {
    // no-op; render handles positioning declaratively
  }

  render() {
    return html`
      ${
        this.hoverRect
          ? html`<div
            class="hover"
            style=${`left:${this.hoverRect.left}px;top:${this.hoverRect.top}px;width:${this.hoverRect.width}px;height:${this.hoverRect.height}px;`}
          ></div>`
          : null
      }
      ${this.markers.flatMap((m) =>
        m.rects.map(
          (r, i) => html`
            <div
              class=${`marker ${m.state} ${this.focusedId === m.id ? "focused" : ""}`}
              data-annotation-id=${m.id}
              style=${`left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`}
            ></div>
            ${
              /* index 0 = no badge: the pending draft, and the secondary spots
                 of a multi-target item (only its first spot names it). */
              i === 0 && m.index > 0
                ? html`<div
                    class=${`badge ${m.state} ${this.focusedId === m.id ? "focused" : ""}`}
                    title="Jump to this annotation in the panel"
                    @click=${(e: Event) => this.onBadgeClick(m.id, e)}
                    style=${`left:${r.left + m.stackIndex * BADGE_STEP_PX}px;top:${r.top}px;z-index:${this.focusedId === m.id ? 60 : 20 + m.stackIndex};`}
                  >${m.index}</div>`
                : null
            }
          `,
        ),
      )}
    `;
  }
}

export const mountOverlay = (): void => {
  if (!customElements.get("lucid-overlay")) {
    customElements.define("lucid-overlay", LucidOverlay);
  }
  const root = document.getElementById(OVERLAY_ROOT_ID);
  if (!root) return;
  const mount = (): void => {
    if (root.querySelector("lucid-overlay")) return;
    root.appendChild(document.createElement("lucid-overlay"));
  };
  mount();
  // Scoped, debounced defensive re-mount: only when our own host loses the
  // overlay element (D-041). Does not react to arbitrary artifact mutation.
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (document.body.contains(root) && !root.querySelector("lucid-overlay")) mount();
      else if (!document.body.contains(root)) {
        document.body.appendChild(root);
        mount();
      }
    }, 100);
  });
  observer.observe(document.body, { childList: true, subtree: false });
};
