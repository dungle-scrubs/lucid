import { css, html, LitElement, type PropertyValues } from "lit";
import {
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
} from "../shared/protocol.ts";

const OVERLAY_ROOT_ID = "__lucid_overlay_root";
const INTERACTIVE =
  "a, button, input, select, textarea, label, [contenteditable], [role=button], summary";

interface Marker {
  readonly id: string;
  readonly resolved: boolean;
  readonly rects: readonly DOMRect[];
}

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
    }
    .marker.resolved {
      background: rgba(246, 224, 94, 0.22);
      border: 1.5px solid rgba(214, 158, 46, 0.85);
      box-shadow: 0 0 0 1px rgba(214, 158, 46, 0.25);
    }
    .marker.focused {
      background: rgba(246, 173, 85, 0.32);
      border-color: rgba(192, 86, 33, 1);
    }
    .badge {
      position: fixed;
      transform: translate(-50%, -50%);
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(214, 158, 46, 0.95);
      color: #1a202c;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("mousemove", this.onMouseMove, true);
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("mouseup", this.onMouseUp, true);
    window.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    window.addEventListener("resize", this.onResize, { passive: true });
    window.addEventListener("message", this.onMessage);
    post({ source: "lucid-overlay", type: "ready" });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("mousemove", this.onMouseMove, true);
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("mouseup", this.onMouseUp, true);
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

  private readonly onMouseMove = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    if (!target || this.isOwn(target)) {
      this.hoverRect = null;
      return;
    }
    this.hoverRect = target.getBoundingClientRect();
  };

  private readonly onClick = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    if (!target || this.isOwn(target)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return; // selection handled on mouseup
    const interactive = target.closest(INTERACTIVE) !== null;
    if (interactive && !e.altKey) return; // controls stay interactive (D-028)
    e.preventDefault();
    e.stopPropagation();
    const anchor = captureElement(target);
    post({ source: "lucid-overlay", type: "target-picked", anchor });
  };

  private readonly onMouseUp = (): void => {
    const anchor = captureRangeAnchor();
    if (anchor) post({ source: "lucid-overlay", type: "target-picked", anchor });
  };

  private readonly onMessage = (e: MessageEvent): void => {
    if (!isChromeMessage(e.data)) return;
    const msg = e.data as ChromeMessage;
    if (msg.type === "highlight") {
      this.committed = [...msg.annotations];
      this.reposition();
    } else if (msg.type === "swap") {
      this.swapArtifact(msg.html);
    } else if (msg.type === "focus-annotation") {
      this.focusedId = msg.id;
      this.reposition();
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
    });
  }

  /** Re-resolve every committed annotation against the live DOM (D-029, D-041). */
  private reposition(): void {
    const markers: Marker[] = [];
    for (const a of this.committed) {
      const rects = this.rectsFor(a);
      if (rects.length > 0) markers.push({ id: a.id, resolved: true, rects });
    }
    this.markers = markers;
  }

  private rectsFor(a: PayloadAnnotationLike): DOMRect[] {
    if (a.target.kind === "element") {
      const el = resolveElementInDocument(a.target);
      if (!el) return [];
      return [el.getBoundingClientRect()];
    }
    const range = resolveRangeInDocument(a.target);
    if (!range) return [];
    return Array.from(range.getClientRects());
  }

  /**
   * Subtree-only swap (D-042): replace the artifact body nodes while preserving
   * the overlay host, then re-resolve anchors. Head <style>/<link> are synced.
   */
  private swapArtifact(htmlText: string): void {
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
    // Sync artifact <style> tags from the new head.
    for (const s of document.head.querySelectorAll("style[data-lucid-artifact-style]")) s.remove();
    parsed.head.querySelectorAll("style").forEach((s) => {
      const clone = document.importNode(s, true);
      clone.setAttribute("data-lucid-artifact-style", "true");
      document.head.appendChild(clone);
    });
    this.scheduleReposition();
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
              class=${`marker resolved ${this.focusedId === m.id ? "focused" : ""}`}
              data-annotation-id=${m.id}
              style=${`left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`}
            ></div>
            ${
              i === 0
                ? html`<div class="badge" style=${`left:${r.left}px;top:${r.top}px;`}>${"✎"}</div>`
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
