import { css, html, LitElement } from "lit";
import type { Anchor } from "../../src/anchors/anchor.ts";
import {
  isOverlayMessage,
  type ChromeMessage,
  type PayloadAnnotationLike,
} from "../shared/protocol.ts";

interface Config {
  readonly mode: string;
  readonly session: string;
  readonly name: string;
  readonly port: number;
  readonly version: number;
}

interface ConversationMessage {
  readonly role: "human" | "agent";
  readonly text: string;
  readonly at: string;
}

interface QueuedAnnotation {
  readonly id: string;
  readonly target: Anchor;
  readonly note: string;
}

interface WarningItem {
  readonly code: string;
  readonly message: string;
}

const uuid = (): string => crypto.randomUUID();

const targetLabel = (target: Anchor): string =>
  target.kind === "element"
    ? target.snippet.replace(/\s+/g, " ").slice(0, 80)
    : `“${target.snippet.slice(0, 80)}”`;

/**
 * The chrome (RFC §1). The Lucid-owned viewer parent: composer, composer queue,
 * conversation log, annotation list, and controls, wrapped around an isolated
 * `<iframe>` surface. Owns all server I/O (SSE + POSTs); the overlay only does
 * DOM targeting and talks to the chrome via postMessage.
 */
export class LucidChrome extends LitElement {
  static properties = {
    annotations: { state: true },
    messages: { state: true },
    version: { state: true },
    reviewResolved: { state: true },
    pendingTarget: { state: true },
    composerNote: { state: true },
    queue: { state: true },
    messageDraft: { state: true },
    newerVersion: { state: true },
    warnings: { state: true },
    status: { state: true },
  };

  declare annotations: PayloadAnnotationLike[];
  declare messages: ConversationMessage[];
  declare version: number;
  declare reviewResolved: boolean;
  declare pendingTarget: Anchor | null;
  declare composerNote: string;
  declare queue: QueuedAnnotation[];
  declare messageDraft: string;
  declare newerVersion: number | null;
  declare warnings: WarningItem[];
  declare status: string;

  private config: Config;
  private iframe: HTMLIFrameElement | null = null;
  private overlayReady = false;
  private pendingSwapHtml: string | null = null;
  private source: EventSource | null = null;

  constructor() {
    super();
    this.config = (window as unknown as { __LUCID__: Config }).__LUCID__;
    this.annotations = [];
    this.messages = [];
    this.version = this.config.version;
    this.reviewResolved = false;
    this.pendingTarget = null;
    this.composerNote = "";
    this.queue = [];
    this.messageDraft = "";
    this.newerVersion = null;
    this.warnings = [];
    this.status = "active";
  }

  static styles = css`
    :host {
      display: block;
      height: 100vh;
      color: #e2e8f0;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      font-size: 13px;
    }
    .root {
      display: grid;
      grid-template-columns: 384px 1fr;
      height: 100vh;
    }
    .panel {
      display: flex;
      flex-direction: column;
      background: #11141b;
      border-right: 1px solid #1f2530;
      overflow: hidden;
    }
    header {
      padding: 14px 16px;
      border-bottom: 1px solid #1f2530;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title { font-weight: 600; letter-spacing: 0.2px; }
    .title small { color: #7b8694; font-weight: 400; display: block; font-size: 11px; }
    .vtag {
      font-variant-numeric: tabular-nums;
      background: #1b2230;
      color: #9fb3c8;
      border-radius: 999px;
      padding: 2px 9px;
      font-size: 11px;
    }
    .scroll { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; }
    section h3 {
      margin: 0 0 8px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #6b7686;
    }
    .empty { color: #4d5666; font-style: italic; font-size: 12px; }
    .card {
      background: #171c25;
      border: 1px solid #232b38;
      border-radius: 8px;
      padding: 10px 11px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .snippet {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: #cbd5e0;
      background: #0d1016;
      border-radius: 5px;
      padding: 5px 7px;
      max-height: 56px;
      overflow: hidden;
      border-left: 2px solid #d69e2e;
    }
    .msg { display: flex; flex-direction: column; gap: 3px; }
    .msg .who { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; }
    .msg.human .who { color: #63b3ed; }
    .msg.agent .who { color: #68d391; }
    .msg .text { white-space: pre-wrap; line-height: 1.45; color: #d7deea; }
    textarea, input.note {
      width: 100%;
      box-sizing: border-box;
      background: #0d1016;
      color: #e2e8f0;
      border: 1px solid #2a3340;
      border-radius: 6px;
      padding: 8px;
      font: inherit;
      resize: vertical;
    }
    textarea:focus, input.note:focus { outline: none; border-color: #3b82f6; }
    .row { display: flex; gap: 8px; align-items: center; }
    button {
      font: inherit;
      font-weight: 600;
      border: 1px solid #2a3340;
      background: #1b2230;
      color: #cfd8e3;
      border-radius: 6px;
      padding: 7px 12px;
      cursor: pointer;
    }
    button:hover { background: #232c3c; }
    button.primary { background: #2563eb; border-color: #2563eb; color: white; }
    button.primary:hover { background: #1d4ed8; }
    button.good { background: #16794d; border-color: #16794d; color: white; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .pill { font-size: 10px; padding: 1px 7px; border-radius: 999px; }
    .pill.orphan { background: #5b2330; color: #fbb6c2; }
    .pill.resolved { background: #1f3a2c; color: #9ae6b4; }
    footer { border-top: 1px solid #1f2530; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
    .surface { position: relative; background: #fff; }
    iframe { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
    .banner {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      background: #d69e2e;
      color: #1a202c;
      padding: 7px 14px;
      border-radius: 8px;
      font-weight: 600;
      box-shadow: 0 4px 14px rgba(0,0,0,0.3);
      z-index: 5;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .banner button { background: #1a202c; color: #fff; border: 0; padding: 4px 10px; }
    .resolved-bar { background: #16310f; color: #9ae6b4; padding: 8px 14px; border-bottom: 1px solid #1f2530; display:flex; justify-content:space-between; align-items:center;}
    .warn { color: #fbb6c2; font-size: 11px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.onMessage);
    void this.bootstrap();
    this.subscribe();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("message", this.onMessage);
    this.source?.close();
  }

  firstUpdated(): void {
    this.iframe = this.renderRoot.querySelector("iframe");
  }

  // ---- server I/O -----------------------------------------------------------

  private async api(path: string, body?: unknown): Promise<Response> {
    return fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async bootstrap(): Promise<void> {
    try {
      const res = await this.api("/__lucid/state");
      const state = (await res.json()) as {
        version: number;
        reviewResolved: boolean;
        annotations: PayloadAnnotationLike[];
        messages: { role: "human" | "agent"; text: string; at: string }[];
        status: string;
      };
      this.version = state.version;
      this.reviewResolved = state.reviewResolved;
      this.annotations = [...state.annotations];
      this.messages = state.messages.map((m) => ({ role: m.role, text: m.text, at: m.at }));
      this.pushHighlights();
    } catch {
      // server may not be ready yet; SSE will fill in
    }
  }

  private subscribe(): void {
    const source = new EventSource("/__lucid/events");
    this.source = source;
    source.onmessage = (e) => this.onLogEvent(e.data);
    source.addEventListener("warning", (e) => {
      try {
        const w = JSON.parse((e as MessageEvent).data) as WarningItem;
        this.warnings = [...this.warnings.slice(-4), w];
      } catch {
        /* ignore */
      }
    });
  }

  private onLogEvent(data: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (ev.t) {
      case "annotation": {
        const id = ev.id as string;
        if (!this.annotations.some((a) => a.id === id)) {
          this.annotations = [
            ...this.annotations,
            {
              id,
              version: ev.version as number,
              resolved: true,
              target: ev.target as Anchor,
              note: ev.note as string,
              at: ev.at as string,
            },
          ];
          this.pushHighlights();
        }
        break;
      }
      case "prompt":
        this.messages = [
          ...this.messages,
          { role: "human", text: ev.text as string, at: ev.at as string },
        ];
        break;
      case "agent_reply":
        this.messages = [
          ...this.messages,
          { role: "agent", text: ev.text as string, at: ev.at as string },
        ];
        break;
      case "review_resolved":
        this.reviewResolved = true;
        break;
      case "review_reopened":
        this.reviewResolved = false;
        break;
      case "version":
        void this.onNewVersion(ev.version as number);
        break;
      case "session_ended":
        this.status = "ended";
        break;
      case "session_suspended":
        this.status = "suspended";
        break;
      default:
        break;
    }
  }

  // ---- live reload (defer-until-committed; D-055) ---------------------------

  private hasUnsentDraft(): boolean {
    return (
      this.queue.length > 0 || (this.pendingTarget !== null && this.composerNote.trim().length > 0)
    );
  }

  private async onNewVersion(version: number): Promise<void> {
    const html = await this.api("/__lucid/artifact")
      .then((r) => r.text())
      .catch(() => null);
    if (html === null) return;
    if (this.hasUnsentDraft()) {
      this.pendingSwapHtml = html;
      this.newerVersion = version;
      return;
    }
    this.applySwap(html, version);
  }

  private applySwap(html: string, version: number): void {
    this.toOverlay({ source: "lucid-chrome", type: "swap", html });
    this.version = version;
    this.newerVersion = null;
    this.pendingSwapHtml = null;
    // version changed -> resolved flags may change; refresh from server
    void this.bootstrap();
  }

  private applyDeferredSwapIfReady(): void {
    if (this.pendingSwapHtml !== null && this.newerVersion !== null && !this.hasUnsentDraft()) {
      this.applySwap(this.pendingSwapHtml, this.newerVersion);
    }
  }

  // ---- overlay bridge -------------------------------------------------------

  private readonly onMessage = (e: MessageEvent): void => {
    if (!isOverlayMessage(e.data)) return;
    if (e.data.type === "ready") {
      this.overlayReady = true;
      this.pushHighlights();
    } else if (e.data.type === "target-picked") {
      this.pendingTarget = e.data.anchor;
    }
  };

  private toOverlay(message: ChromeMessage): void {
    this.iframe?.contentWindow?.postMessage(message, "*");
  }

  private pushHighlights(): void {
    if (!this.overlayReady) return;
    this.toOverlay({ source: "lucid-chrome", type: "highlight", annotations: this.annotations });
  }

  // ---- composer actions -----------------------------------------------------

  private addToQueue(): void {
    if (!this.pendingTarget || this.composerNote.trim().length === 0) return;
    this.queue = [
      ...this.queue,
      { id: uuid(), target: this.pendingTarget, note: this.composerNote.trim() },
    ];
    this.pendingTarget = null;
    this.composerNote = "";
  }

  private discardPending(): void {
    this.pendingTarget = null;
    this.composerNote = "";
    this.applyDeferredSwapIfReady();
  }

  private removeQueued(id: string): void {
    this.queue = this.queue.filter((q) => q.id !== id);
    this.applyDeferredSwapIfReady();
  }

  private async sendQueue(): Promise<void> {
    const items = this.queue;
    for (const q of items) {
      await this.api("/__lucid/annotation", {
        id: q.id,
        version: this.version,
        target: q.target,
        note: q.note,
      });
    }
    this.queue = [];
    this.applyDeferredSwapIfReady();
  }

  private async sendMessage(): Promise<void> {
    const text = this.messageDraft.trim();
    if (text.length === 0) return;
    this.messageDraft = "";
    await this.api("/__lucid/message", { id: uuid(), text, refs: [] });
  }

  private async resolveReview(): Promise<void> {
    await this.api("/__lucid/resolve", {});
  }

  private async reopenReview(): Promise<void> {
    await this.api("/__lucid/reopen", {});
  }

  // ---- render ---------------------------------------------------------------

  render() {
    const orphans = this.annotations.filter((a) => !a.resolved);
    const located = this.annotations.filter((a) => a.resolved);
    return html`
      <div class="root">
      <div class="panel">
        <header>
          <div class="title">Lucid review<small>${this.config.name}</small></div>
          <div class="vtag" title="current artifact version">v${this.version}</div>
        </header>

        ${
          this.reviewResolved
            ? html`<div class="resolved-bar"><span>✓ Review approved</span><button @click=${this.reopenReview}>Reopen review</button></div>`
            : null
        }

        <div class="scroll">
          ${
            this.pendingTarget
              ? html`
                <section>
                  <h3>New annotation</h3>
                  <div class="card">
                    <div class="snippet">${targetLabel(this.pendingTarget)}</div>
                    <textarea
                      rows="3"
                      placeholder="What should change here?"
                      .value=${this.composerNote}
                      @input=${(e: Event) => (this.composerNote = (e.target as HTMLTextAreaElement).value)}
                    ></textarea>
                    <div class="row">
                      <button class="primary" data-test="add-to-queue" @click=${this.addToQueue}>Add to queue</button>
                      <button data-test="discard" @click=${this.discardPending}>Discard</button>
                    </div>
                  </div>
                </section>
              `
              : html`<section><h3>New annotation</h3><div class="empty">Click an element or select text in the artifact to annotate it.</div></section>`
          }

          ${
            this.queue.length > 0
              ? html`
                <section>
                  <h3>Queued (${this.queue.length})</h3>
                  ${this.queue.map(
                    (q) => html`
                      <div class="card">
                        <div class="snippet">${targetLabel(q.target)}</div>
                        <div>${q.note}</div>
                        <div class="row"><button @click=${() => this.removeQueued(q.id)}>Remove</button></div>
                      </div>
                    `,
                  )}
                  <button class="primary" data-test="send-queue" @click=${this.sendQueue}>Send ${this.queue.length} annotation${this.queue.length > 1 ? "s" : ""}</button>
                </section>
              `
              : null
          }

          <section>
            <h3>Annotations (${this.annotations.length})</h3>
            ${this.annotations.length === 0 ? html`<div class="empty">No feedback sent yet.</div>` : null}
            ${located.map(
              (a) => html`
                <div class="card" data-test="annotation" @mouseenter=${() => this.toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: a.id })}>
                  <div class="row" style="justify-content:space-between">
                    <span class="pill resolved">located · v${a.version}</span>
                  </div>
                  <div class="snippet">${targetLabel(a.target)}</div>
                  <div>${a.note}</div>
                </div>
              `,
            )}
            ${
              orphans.length > 0
                ? html`
                  <h3 style="margin-top:8px">Orphaned (${orphans.length})</h3>
                  ${orphans.map(
                    (a) => html`
                      <div class="card" data-test="orphan">
                        <span class="pill orphan">orphaned · v${a.version}</span>
                        <div class="snippet">${targetLabel(a.target)}</div>
                        <div>${a.note}</div>
                      </div>
                    `,
                  )}
                `
                : null
            }
          </section>

          <section>
            <h3>Conversation</h3>
            ${this.messages.length === 0 ? html`<div class="empty">No messages.</div>` : null}
            ${this.messages.map(
              (m) =>
                html`<div class="msg ${m.role}"><span class="who">${m.role}</span><span class="text">${m.text}</span></div>`,
            )}
          </section>

          ${
            this.warnings.length > 0
              ? html`<section><h3>Warnings</h3>${this.warnings.map((w) => html`<div class="warn">${w.code}: ${w.message}</div>`)}</section>`
              : null
          }
        </div>

        <footer>
          <textarea
            rows="2"
            placeholder="Message the agent (not tied to an element)…"
            .value=${this.messageDraft}
            @input=${(e: Event) => (this.messageDraft = (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="row" style="justify-content:space-between">
            <button data-test="send-message" @click=${this.sendMessage}>Send message</button>
            ${
              this.reviewResolved
                ? null
                : html`<button class="good" data-test="approve" @click=${this.resolveReview}>Approve review</button>`
            }
          </div>
        </footer>
      </div>

      <div class="surface">
        ${
          this.newerVersion !== null
            ? html`<div class="banner" data-test="newer-version">Newer version (v${this.newerVersion}) available · send or discard your draft<button @click=${this.discardPending}>Discard draft</button></div>`
            : null
        }
        <iframe src="/" title="artifact surface"></iframe>
      </div>
      </div>
    `;
  }
}

export const mountChrome = (): void => {
  if (!customElements.get("lucid-chrome")) {
    customElements.define("lucid-chrome", LucidChrome);
  }
};
