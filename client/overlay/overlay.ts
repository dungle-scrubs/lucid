import { css, html, LitElement, type PropertyValues } from "lit";
import {
  type Anchor,
  captureElement,
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

/** The id of the single in-flight (pending) composer anchor marker. */
const PENDING_ID = "__lucid_pending";

interface Marker {
  readonly id: string;
  /** Lifecycle state of the annotation this marker anchors; drives its style. */
  readonly state: MarkerState;
  /** 1-based number shared with the left-panel card; 0 = no badge (pending). */
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
  private pendingAnchor: Anchor | null = null;
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
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    .hover {
      position: fixed;
      border: 1.5px dashed rgba(99, 179, 237, 0.9);
      background: rgba(99, 179, 237, 0.08);
      border-radius: 3px;
      pointer-events: none;
      transition: all 0.04s linear;
    }
    .marker {
      position: fixed;
      border-radius: 3px;
      pointer-events: none;
      box-sizing: border-box;
      transition: background 0.1s linear, box-shadow 0.1s linear;
    }
    /* committed = sent (brass solid); queued = composed-but-unsent (brass dashed);
       pending = the anchor being composed right now (blue, active). */
    .marker.committed {
      background: rgba(246, 224, 94, 0.20);
      border: 1.5px solid rgba(214, 158, 46, 0.85);
      box-shadow: 0 0 0 1px rgba(214, 158, 46, 0.22);
    }
    .marker.queued {
      background: rgba(203, 168, 90, 0.12);
      border: 1.5px dashed rgba(203, 168, 90, 0.9);
    }
    .marker.pending {
      background: rgba(99, 179, 237, 0.16);
      border: 1.5px solid rgba(99, 179, 237, 0.95);
      box-shadow: 0 0 0 2px rgba(99, 179, 237, 0.22);
    }
    .marker.focused {
      background: rgba(246, 224, 94, 0.42);
      box-shadow: 0 0 0 2px rgba(214, 158, 46, 0.55);
    }
    .badge {
      position: fixed;
      /* Centred on the anchor's top-left corner, so it straddles the edge. */
      transform: translate(-50%, -50%);
      width: 20px;
      height: 20px;
      border-radius: 999px;
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
      background: rgba(214, 158, 46, 0.97);
    }
    .badge.queued {
      background: rgba(203, 168, 90, 0.95);
      border: 1px dashed rgba(110, 84, 28, 0.7);
    }
    .badge.focused {
      box-shadow: 0 0 0 3px rgba(214, 158, 46, 0.5);
      filter: brightness(1.08);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("mousemove", this.onMouseMove, true);
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("mouseup", this.onMouseUp, true);
    document.addEventListener("mouseleave", this.onMouseLeaveDoc);
    window.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    window.addEventListener("resize", this.onResize, { passive: true });
    window.addEventListener("message", this.onMessage);
    post({ source: "lucid-overlay", type: "ready" });
    this.publishSectionIds();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("mousemove", this.onMouseMove, true);
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("mouseup", this.onMouseUp, true);
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

  /** Inject the redline stylesheet into the artifact realm (sage/rust/brass). */
  private injectDiffStyles(): void {
    if (document.getElementById("__lucid_diff_style")) return;
    const style = document.createElement("style");
    style.id = "__lucid_diff_style";
    style.textContent = `
      [data-diff="added"] { box-shadow: inset 3px 0 0 #7d8e63; background: rgba(125,142,99,0.10); border-radius: 3px; }
      [data-diff="changed"] { box-shadow: inset 3px 0 0 #97a67e; }
      .lucid-diff-was, .lucid-diff-now { display: block; border-radius: 3px; padding: 2px 6px; }
      .lucid-diff-was { text-decoration: line-through; opacity: 0.7; background: rgba(192,97,63,0.12); }
      .lucid-diff-now { margin-top: 3px; background: rgba(125,142,99,0.12); }
      .lucid-diff-was::before, .lucid-diff-now::before { display: block; font-size: 9px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; text-decoration: none; opacity: 0.8; }
      .lucid-diff-was::before { content: "was"; color: #c0613f; }
      .lucid-diff-now::before { content: "now"; color: #7d8e63; }
      .lucid-ghost { display: block; opacity: 0.55; text-decoration: line-through; background: rgba(192,97,63,0.08); box-shadow: inset 3px 0 0 #c0613f; border-radius: 3px; }
      [data-hunk].lucid-active { outline: 2px solid #bd9a4e; outline-offset: 3px; border-radius: 3px; scroll-margin: 80px; }
    `;
    document.head.appendChild(style);
  }

  private removeDiffStyles(): void {
    document.getElementById("__lucid_diff_style")?.remove();
  }

  /** Injected once, survives artifact swaps (it lives in <head>, not the body
   *  the swap rebuilds). The outline fades to nothing so the emphasis is a
   *  glance, not a permanent mark on the artifact. */
  private injectSectionStyle(): void {
    if (document.getElementById("__lucid_section_style")) return;
    const style = document.createElement("style");
    style.id = "__lucid_section_style";
    style.textContent = `
      @keyframes __lucid_section_flash { from { outline-color: rgba(189,154,78,0.9); } to { outline-color: rgba(189,154,78,0); } }
      .__lucid_section_target { outline: 2px solid rgba(189,154,78,0.9); outline-offset: 3px; border-radius: 3px; scroll-margin: 80px; animation: __lucid_section_flash 1.6s ease-out forwards; }
    `;
    document.head.appendChild(style);
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
    post({ source: "lucid-overlay", type: "target-picked", anchor });
  };

  /** The ✎ badge is the existing annotation's handle: click it to jump to its card. */
  private readonly onBadgeClick = (id: string, e: Event): void => {
    e.stopPropagation();
    post({ source: "lucid-overlay", type: "annotation-activate", id });
  };

  private readonly onMouseUp = (): void => {
    if (!this.showTargets) return; // read mode: selecting text is just selecting text
    const anchor = captureRangeAnchor();
    if (anchor) post({ source: "lucid-overlay", type: "target-picked", anchor });
  };

  private readonly onMessage = (e: MessageEvent): void => {
    if (!isChromeMessage(e.data)) return;
    const msg = e.data as ChromeMessage;
    if (msg.type === "highlight") {
      this.committed = [...msg.annotations];
      this.queuedAnchors = [...msg.queued];
      this.pendingAnchor = msg.pending;
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
    let n = 0;
    for (const a of this.committed) {
      if (!a.resolved) continue; // orphaned annotations have no live anchor to paint
      n += 1;
      const rects = this.rectsFor(a.target);
      if (rects.length > 0) markers.push({ id: a.id, state: "committed", index: n, rects });
    }
    this.queuedAnchors.forEach((q, i) => {
      const rects = this.rectsFor(q.target);
      if (rects.length > 0) markers.push({ id: q.id, state: "queued", index: i + 1, rects });
    });
    if (this.pendingAnchor) {
      const rects = this.rectsFor(this.pendingAnchor);
      if (rects.length > 0) markers.push({ id: PENDING_ID, state: "pending", index: 0, rects });
    }
    // Two annotations on one element resolve to the same rect, so their badges
    // would sit exactly on top of each other. Count the earlier ones per corner
    // and let render step each into a cascade.
    const perCorner = new Map<string, number>();
    this.markers = markers.map((m) => {
      const r = m.rects[0];
      if (!r) return { ...m, stackIndex: 0 };
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
              i === 0 && m.state !== "pending"
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
