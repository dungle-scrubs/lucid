/**
 * The browser surface, client side.
 *
 * The record is the source of truth, so this component never owns
 * conversation state. It polls the projection the server derives from the
 * log and replaces its message list wholesale. Sending appends an input and
 * then waits for the next poll to show it, exactly as the terminal does —
 * nothing is rendered because the browser believes it happened.
 *
 * assistant-ui supplies the thread through `useExternalStoreRuntime`, which
 * is the adapter for precisely this shape: state lives elsewhere, the
 * runtime renders it. The styled `Thread` component is not part of the
 * library (0.10 ships primitives and generates the styled layer into the
 * consuming project), so the small composition below is that layer.
 *
 * The token is fetched from the server rather than baked in, because the
 * page is a static bundle. A restart mints a new one, so a page holding the
 * old token gets 401 and stops; it does not retry against a server that
 * will never accept it.
 */
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  getExternalStoreMessage,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessage,
} from "@assistant-ui/react";
import * as Popover from "@radix-ui/react-popover";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  type Annotation,
  type AnnotationSpot,
  clampSnippet,
  encodeAnnotationBatch,
  NOTE_QUEUE_MAX,
  queueAdmits,
} from "../../protocol/annotations.js";
import {
  type Confidence,
  resolveSpot,
  type SpotSelectors,
  selectorsFor,
  sha256Hex,
} from "./anchor.js";
import { isModeToggle, isQueueSend } from "./hotkeys.js";
import { ELEMENT_ID, FRAME_MESSAGE_SOURCE, instrumentArtifact } from "./instrument.js";
import {
  CONVERSATION_MAX,
  CONVERSATION_MIN,
  clampConversationWidth,
  readConversationWidth,
  writeConversationWidth,
} from "./layout.js";
import { formatRoute, parseRoute, type Route, sameRoute } from "./route.js";
import { type Msg, type PendingNote, type SentBatch, weaveNotes } from "./timeline.js";

/** Kept in step with the server's own poll interval. */
const POLL_MS = 500;
const TOKEN_HEADER = "x-lucid-token";

interface Line {
  readonly kind: "agent" | "human";
  readonly seq?: number;
  readonly text: string;
  readonly mark?: string;
  readonly aborted?: boolean;
  readonly event?: string;
  readonly batch?: SentBatch;
}

interface Activity {
  readonly turn: boolean;
  /** Delivered inputs whose turn has produced no terminal event. */
  readonly inFlight: number;
  /** Written but not delivered to anyone. */
  readonly waiting: number;
}

interface Driver {
  readonly harness?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly harnessVersion?: string;
}

/** The conversation, and now the artifact and the version, are named by the
 * URL and never by the bundle. `route.ts` owns the shape. */
const routeFromPath = (): Route | null => parseRoute(window.location.pathname);

const linesToMessages = (lines: readonly Line[]): Msg[] =>
  lines
    .filter((l) => l.text.trim() !== "")
    .map((l, i) => ({
      id: l.seq === undefined ? `l-${i}` : `s-${l.seq}-${i}`,
      role: l.kind === "agent" ? ("assistant" as const) : ("user" as const),
      text: l.text,
      ...(l.event === "tool" ? { tool: true } : {}),
      ...(l.batch === undefined ? {} : { sentBatch: l.batch }),
    }));

/** Who said it has to survive into the DOM: a transcript where the person
 * and the agent look identical is not a transcript. The role is not on the
 * message element, so it is read through `If` and written as a class. */
/** How a sent note re-attached in the version on screen, keyed by what the
 * note said and what it pointed at. Context rather than a prop because the
 * component is handed to assistant-ui, which does the rendering. */
const Resolutions = React.createContext<
  ReadonlyMap<string, { lost: boolean; later: boolean; how: string | null }>
>(new Map());

const Message = (): React.ReactElement => {
  const resolutions = React.useContext(Resolutions);
  const resolutionFor = (note: string, snippet: string) =>
    resolutions.get(`${note}\u0000${snippet}`);
  // A tool call is the agent working, not the agent talking. Rendered as a
  // message it looks like something to read, and six of them in a row bury
  // the one thing that was.
  const original = useMessage((m) => getExternalStoreMessage<Msg>(m));
  const one = Array.isArray(original) ? original[0] : original;

  if (one?.tool === true) {
    return (
      <MessagePrimitive.Root>
        <div className="msg tool">
          <span className="tool-mark">⚙</span>
          <div className="body">
            <MessagePrimitive.Parts />
          </div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (one?.sentBatch !== undefined) {
    const b = one.sentBatch;
    return (
      <MessagePrimitive.Root>
        <div className="batch">
          {b.notes.map((n) => {
            const spot = n.spots[0];
            const status = resolutionFor(n.note, spot?.snippet ?? "");
            return (
              <div
                className={
                  status?.lost === true
                    ? "note-card orphan"
                    : status?.later === true
                      ? "note-card later"
                      : "note-card sent"
                }
                key={`${n.note}:${spot?.id ?? ""}`}
              >
                <span className="note-card-head">
                  {status?.later === true
                    ? `written against v${b.version} · not on this one`
                    : status?.lost === true
                      ? `lost its target · from v${b.version}`
                      : status === undefined || status.how === null
                        ? `sent · v${b.version}`
                        : `sent · ${status.how} · v${b.version}`}
                </span>
                <span className="note-card-note">{n.note}</span>
                <span className="note-card-spot">
                  on {n.spots.map((sp) => `“${sp.snippet.slice(0, 40)}”`).join(", ")}
                </span>
              </div>
            );
          })}
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (one?.pendingNote !== undefined) {
    const pn = one.pendingNote;
    return (
      <MessagePrimitive.Root>
        <div className="note-card pending">
          <span className="note-card-head">not sent</span>
          <span className="note-card-note">{pn.note}</span>
          <span className="note-card-spot">
            on {pn.spots.map((sp) => `“${sp.snippet.slice(0, 44)}”`).join(", ")}
          </span>
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (one?.note === true) {
    return (
      <MessagePrimitive.Root>
        <div className="msg happened">
          <div className="body">
            <MessagePrimitive.Parts />
          </div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.If user>
        <div className="msg user">
          <div className="body">
            <MessagePrimitive.Parts />
          </div>
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <div className="msg agent">
          <span className="who">agent</span>
          <div className="body">
            <MessagePrimitive.Parts />
          </div>
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
};

/** The scroll behaviour is assistant-ui's, not lucid's.
 *
 * `Viewport autoScroll` watches the content with a ResizeObserver and
 * tracks whether you are at the bottom: new content follows you down when
 * you are there, and leaves you alone when you have scrolled up. The
 * ResizeObserver is the part a hand-rolled version gets wrong — text
 * reflows after the effect runs, which leaves the viewport short of the
 * end.
 *
 * `ScrollToBottom` is its affordance for getting back, and it hides itself
 * when you are already there. */
const Thread = ({
  pending,
  onSendNotes,
  onDiscardNotes,
  sending,
  activity,
  quietFor,
}: {
  pending: readonly PendingNote[];
  onSendNotes: () => void;
  onDiscardNotes: () => void;
  sending: boolean;
  activity: Activity;
  /** Seconds since the transcript last changed. */
  quietFor: number;
}): React.ReactElement => {
  const stalled = quietFor > 45 && !activity.turn;
  const busy = activity.turn || activity.inFlight > 0 || activity.waiting > 0;
  return (
    <ThreadPrimitive.Root className="thread-root">
      {/* The half that scrolls. Only messages and note cards are in here, so
          nothing that has to stay put competes with the scrolling. */}
      <div className="thread-wrap">
        <ThreadPrimitive.Viewport autoScroll className="thread">
          <ThreadPrimitive.Empty>
            <div className="empty">Nothing in this conversation yet.</div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ Message }} />
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ScrollToBottom asChild>
          <button type="button" className="to-bottom">
            ↓ latest
          </button>
        </ThreadPrimitive.ScrollToBottom>
      </div>

      {/* The half that does not. One solid block at the bottom: what is
          happening, what is queued, and the box you type in. The queue bar
          was sticky inside the scroller and lay over the conversation
          instead of sitting under it. */}
      <div className="dock">
        {busy ? (
          <div className={stalled ? "activity stalled" : "activity"}>
            <span className="pulse" />
            <span>
              {activity.turn
                ? "the agent is working"
                : activity.inFlight > 0
                  ? `${activity.inFlight} sent, waiting for the agent`
                  : `${activity.waiting} written, not delivered yet`}
              {stalled ? ` — nothing back for ${Math.round(quietFor)}s` : ""}
            </span>
          </div>
        ) : null}

        {pending.length === 0 ? null : (
          <div className="queue-bar">
            <span>
              {pending.length} note{pending.length === 1 ? "" : "s"} queued
              {/* Only near the bound. A count out of a maximum on an empty
                  queue is a limit nobody was going to reach. */}
              {pending.length >= NOTE_QUEUE_MAX - 4 ? ` of ${NOTE_QUEUE_MAX}` : ""}
            </span>
            <button
              type="button"
              className="primary"
              onClick={onSendNotes}
              disabled={sending}
              title="Send the queued notes (⌘⏎)"
            >
              {sending ? "Sending…" : "Send ⌘⏎"}
            </button>
            <button type="button" className="discard" onClick={onDiscardNotes} title="Discard them">
              ×
            </button>
          </div>
        )}

        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input autoFocus placeholder="Send to the conversation…" rows={1} />
          <ComposerPrimitive.Send asChild>
            <button type="submit">Send</button>
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
};
interface CatalogEntry {
  readonly artifactId: string;
  readonly versions: readonly number[];
  readonly latest: number;
  readonly authors?: Readonly<Record<number, string>>;
}

interface Doc {
  readonly artifactId: string;
  readonly version: number;
  readonly contentType: string;
  readonly bytes: string;
}

/** How often the document channel is asked for news.
 *
 * Slower than the conversation on purpose. A transcript changes constantly
 * and costs a few lines; a document changes rarely and costs its whole
 * size. Only the catalog is polled — it is versions and ids, no bytes — and
 * a version is fetched once, when it turns out to be new. */
const CATALOG_POLL_MS = 2000;

/** The document, in a frame the page cannot reach into.
 *
 * `srcdoc` hands the frame its bytes; the frame fetches nothing, so a
 * document that names an external image or script gets neither.
 *
 * The sandbox has no `allow-same-origin`, which is the whole point. With
 * it the parent could read into the frame — and the frame could read back
 * out, into a page holding a token with read and write on every record.
 * The document is written by an agent, so that reach is not one to grant.
 * Without it the frame is an opaque origin: nothing crosses in either
 * direction. `allow-scripts` alone is safe precisely because the origin is
 * opaque; the two together would not be.
 *
 * `key` is the version, so a new version replaces the frame rather than
 * mutating it. There is no in-place update path to get wrong. */
/** Where a selection sits inside the frame, in the frame's own viewport. */
interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame is not trusted, so the rect is checked like anything else it
 * sends. A bad one means no anchor, not a thrown render. */
const readRect = (raw: unknown): SelectionRect | null => {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const nums = [r.x, r.y, r.width, r.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    x: r.x as number,
    y: r.y as number,
    width: r.width as number,
    height: r.height as number,
  };
};

const DocumentFrame = ({
  doc,
  onSelection,
  capture,
  snapshot,
  deselect,
  onHotkey,
  onDirty,
  marked,
  mode,
  readOnly,
}: {
  doc: Doc;
  onSelection: (ids: readonly string[], rect: SelectionRect | null) => void;
  /** Handed the frame's answer to a capture request. */
  capture: React.MutableRefObject<((ids: readonly string[]) => Promise<AnnotationSpot[]>) | null>;
  /** Handed the frame's answer to a snapshot request: the document as it now
   * reads, with lucid's instrumentation taken back out, and the values of
   * the controls the agent authored. */
  snapshot: React.MutableRefObject<
    (() => Promise<{ html: string; values: Record<string, string> } | null>) | null
  >;
  /** Handed a way to drop the frame's selection, for backing out of a note. */
  deselect: React.MutableRefObject<(() => void) | null>;
  /** A key the frame caught that means something to the whole page. */
  onHotkey: (which: "toggle-mode" | "send-queue") => void;
  /** The frame says when a person has changed something in it. */
  onDirty: () => void;
  /** Spots that already carry a note, marked in the document while the
   * batch is being composed. */
  marked: readonly string[];
  mode: "use" | "markup";
  /** A version that is not the current one. Neither editable nor markable
   * (RFC-07 R6, R7). Not a third mode: the mode still stands, and applies
   * again the moment the current version is back. */
  readOnly: boolean;
}): React.ReactElement => {
  const ref = React.useRef<HTMLIFrameElement | null>(null);
  const pending = React.useRef(new Map<string, (spots: AnnotationSpot[]) => void>());
  const snaps = React.useRef(
    new Map<string, (v: { html: string; values: Record<string, string> } | null) => void>(),
  );
  const nextToken = React.useRef(0);

  // A `message` listener hears from every frame on the page and from any
  // origin. The boundary exists only because this checks.
  React.useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      // The frame is sandboxed without `allow-same-origin`, so its origin
      // is opaque and there is nothing to compare. Identity of the sending
      // window is the check.
      const frame = ref.current;
      if (frame === null || e.source !== frame.contentWindow) return;

      // Arriving on that channel is not the same as being true. The shape
      // is checked before any of it is believed.
      const m = e.data as Record<string, unknown> | null;
      if (m === null || typeof m !== "object") return;
      if (m.source !== FRAME_MESSAGE_SOURCE) return;

      // A key press is about the page, not about a version of a document, so
      // it carries no artifact and is answered before anything is checked
      // against one.
      if (m.kind === "hotkey") {
        if (m.hotkey === "toggle-mode" || m.hotkey === "send-queue") onHotkey(m.hotkey);
        return;
      }

      if (
        m.kind !== "selection" &&
        m.kind !== "captured" &&
        m.kind !== "snapshot-taken" &&
        m.kind !== "dirty"
      )
        return;
      if (m.artifactId !== doc.artifactId || m.version !== doc.version) return;
      if (m.kind === "dirty") {
        onDirty();
        return;
      }

      if (m.kind === "snapshot-taken") {
        const token = typeof m.token === "string" ? m.token : "";
        const settle = snaps.current.get(token);
        if (settle === undefined) return;
        snaps.current.delete(token);
        if (typeof m.html !== "string") {
          settle(null);
          return;
        }
        const values: Record<string, string> = {};
        if (m.values !== null && typeof m.values === "object" && !Array.isArray(m.values)) {
          for (const [k, v] of Object.entries(m.values as Record<string, unknown>)) {
            if (typeof v === "string") values[k] = v;
          }
        }
        settle({ html: m.html, values });
        return;
      }

      if (m.kind === "captured") {
        // The answer to a capture this page asked for, matched by the token
        // it was asked with — an answer nobody is waiting for is dropped.
        const token = typeof m.token === "string" ? m.token : "";
        const settle = pending.current.get(token);
        if (settle === undefined) return;
        pending.current.delete(token);
        if (!Array.isArray(m.spots)) {
          settle([]);
          return;
        }
        const spots: AnnotationSpot[] = [];
        for (const raw of m.spots) {
          if (raw === null || typeof raw !== "object") continue;
          const sp = raw as Record<string, unknown>;
          if (typeof sp.id !== "string" || !ELEMENT_ID.test(sp.id)) continue;
          if (typeof sp.snippet !== "string" || typeof sp.author !== "string") continue;
          spots.push({ id: sp.id, snippet: clampSnippet(sp.snippet), author: sp.author });
        }
        settle(spots);
        return;
      }

      if (!Array.isArray(m.ids)) return;
      if (!m.ids.every((id) => typeof id === "string" && ELEMENT_ID.test(id))) return;

      onSelection(m.ids as string[], readRect(m.rect));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [doc.artifactId, doc.version, onSelection, onHotkey, onDirty]);

  // Asking the frame what is at a set of spots. The parent cannot read the
  // document, so it asks and the frame answers — the boundary stays one
  // narrow message in each direction.
  React.useEffect(() => {
    capture.current = (ids) =>
      new Promise<AnnotationSpot[]>((resolve) => {
        const frame = ref.current;
        if (frame === null || frame.contentWindow === null) return resolve([]);
        const token = `c${nextToken.current++}`;
        pending.current.set(token, resolve);
        frame.contentWindow.postMessage(
          { source: FRAME_MESSAGE_SOURCE, kind: "capture", token, ids: [...ids] },
          "*",
        );
        // A frame that never answers must not leave a note half-written.
        window.setTimeout(() => {
          if (pending.current.delete(token)) resolve([]);
        }, 2000);
      });
    snapshot.current = () =>
      new Promise((resolve) => {
        const frame = ref.current;
        if (frame === null || frame.contentWindow === null) return resolve(null);
        const token = `s${nextToken.current++}`;
        snaps.current.set(token, resolve);
        frame.contentWindow.postMessage(
          { source: FRAME_MESSAGE_SOURCE, kind: "snapshot", token },
          "*",
        );
        window.setTimeout(() => {
          if (snaps.current.delete(token)) resolve(null);
        }, 4000);
      });
    deselect.current = () =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "deselect" },
        "*",
      );
    return () => {
      capture.current = null;
      snapshot.current = null;
      deselect.current = null;
    };
  }, [capture, snapshot, deselect]);

  React.useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      { source: FRAME_MESSAGE_SOURCE, kind: "mark", ids: [...marked] },
      "*",
    );
  }, [marked]);

  React.useEffect(() => {
    // Sent on a timer as well as on change: the frame is replaced whenever
    // the version changes, and a fresh frame starts in use mode.
    const send = (): void =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "mode", mode, readOnly },
        "*",
      );
    send();
    const id = window.setInterval(send, 1000);
    return () => window.clearInterval(id);
  }, [mode, readOnly]);

  return (
    <iframe
      ref={ref}
      key={`${doc.artifactId}@${doc.version}`}
      className="doc-frame"
      title={`${doc.artifactId} v${doc.version}`}
      sandbox="allow-scripts"
      srcDoc={instrumentArtifact(doc.bytes, doc.artifactId, doc.version)}
    />
  );
};

/**
 * The other artifacts in this conversation.
 *
 * Labelled in terms of the conversation, never as a relationship: artifacts
 * are siblings in a record, nothing in the record links one to another, and
 * calling them "related" would name something that does not exist.
 *
 * Only rendered when there is more than one. A list of one is a label.
 */
const AlsoHere = ({
  artifacts,
  showing,
  conversationId,
  onOpen,
}: {
  artifacts: readonly CatalogEntry[];
  showing: string | null;
  conversationId: string;
  onOpen: (artifactId: string) => void;
}): React.ReactElement | null => {
  if (artifacts.length < 2) return null;
  return (
    <div className="also">
      <span className="also-label">Also in this conversation</span>
      {artifacts.map((a) => {
        const here = a.artifactId === showing;
        return (
          <span key={a.artifactId} className={here ? "also-one here" : "also-one"}>
            <button
              type="button"
              className="also-open"
              onClick={() => onOpen(a.artifactId)}
              disabled={here}
              title={here ? "Showing this one" : `Show ${a.artifactId}`}
            >
              {a.artifactId}
              <span className="also-v">v{a.latest}</span>
            </button>
            {/* A real link, so the browser's own open-in-new-tab works: the
                middle click, the modifier click, and the context menu. A
                button with a click handler gives none of those. */}
            <a
              className="also-tab"
              href={formatRoute({ conversationId, artifactId: a.artifactId })}
              target="_blank"
              rel="noreferrer"
              title="Open in a new tab"
            >
              ↗
            </a>
          </span>
        );
      })}
    </div>
  );
};

const App = (): React.ReactElement => {
  // Read once. Where in the record the page starts is an opening question;
  // after that the page moves the address bar, not the other way round.
  const opened = React.useMemo(routeFromPath, []);
  const conversationId = opened?.conversationId ?? "";
  /** The artifact the URL asked for, until a person picks another. */
  const [wantArtifact, setWantArtifact] = React.useState<string | null>(opened?.artifactId ?? null);
  /** Show another artifact. The pin goes with it: a version number belongs
   * to the artifact it came from, and carrying v7 across would ask for a
   * version of a different document. */
  const openArtifact = React.useCallback((artifactId: string): void => {
    setWantArtifact(artifactId);
    setPinned(null);
    setUnknownArtifact(null);
  }, []);

  /** An artifact the URL named that the record does not hold. */
  const [unknownArtifact, setUnknownArtifact] = React.useState<string | null>(null);
  const [token, setToken] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [status, setStatus] = React.useState<string>("");
  /** What is driving: harness, model when known, and profile. */
  const [driver, setDriver] = React.useState<Driver>({});
  const [activity, setActivity] = React.useState<Activity>({
    turn: false,
    inFlight: 0,
    waiting: 0,
  });
  /** When the transcript last changed. A conversation that is waiting and a
   * conversation that has stopped look identical without it — which is how
   * a wedged harness sat silent for ninety minutes with eight inputs
   * delivered and nothing said. */
  const [lastChange, setLastChange] = React.useState(() => Date.now());
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const [problem, setProblem] = React.useState<string | null>(null);
  /** Set once on 401. Every fetch stops: the token can only come back by
   * reloading, and retrying a dead token forever is the failure this flag
   * exists to prevent. */
  const [dead, setDead] = React.useState(false);
  const [doc, setDoc] = React.useState<Doc | null>(null);
  /** Which version is on screen. Compared against the catalog so a fetch
   * happens on a new version and not on every tick. */
  const shown = React.useRef<string>("");
  /** True while a version is being fetched. A new version appears when
   * nothing is in progress, so a slow fetch never has a second one racing
   * it, and the frame is never swapped halfway. */
  const fetching = React.useRef(false);
  /** One selection, however many spots are in it. A new version clears it:
   * an id addresses an element in the render it came from, and the next
   * version is a different render. */
  const [selection, setSelection] = React.useState<readonly string[]>([]);
  /** Every version the record holds, and which spots already carry a sent
   * note on each. */
  const [catalog, setCatalog] = React.useState<CatalogEntry | null>(null);
  /** Every artifact the record holds. The catalog endpoint has always
   * returned all of them; the page kept only the one it was showing, which
   * is what made the rest unreachable. */
  const [allArtifacts, setAllArtifacts] = React.useState<readonly CatalogEntry[]>([]);
  /** Sent notes, by `artifactId@version` — the version each was made
   * against. */
  const [sentNotes, setSentNotes] = React.useState<Record<string, Annotation[]>>({});
  /** Where each sent note points in the version on screen, and how
   * confidently it got there. A note made against this version needs no
   * resolving; one from an earlier version does. */
  const [anchored, setAnchored] = React.useState<
    readonly {
      readonly note: string;
      readonly fromVersion: number;
      readonly elementId: string | null;
      readonly how: Confidence | null;
      readonly why: string | null;
      readonly snippet: string;
    }[]
  >([]);
  /** The version asked for. Null means "follow the newest" — the ordinary
   * state, where a new version simply appears.
   *
   * Choosing a version always pins it, the newest included. The rule that
   * lucid never changes version under pending work is about lucid moving
   * someone, not about someone moving themselves, and a pin is how the two
   * are told apart. */
  // A version named in the URL opens pinned to it: a link to a version has
  // to land on that version, not on the newest one.
  const [pinned, setPinned] = React.useState<number | null>(opened?.version ?? null);
  /** A version that arrived while there was work pending. It waits here and
   * is announced rather than swapped in underneath. */
  const [waiting, setWaiting] = React.useState<number | null>(null);
  /** Notes written but not yet sent. They accumulate: a batch is composed
   * over several selections and leaves as one act. */
  /** Unsent notes, kept per version. A note addresses an element in the
   * render it was made against, so it belongs to that version — and looking
   * at another version and coming back must not have lost it. */
  const [notesByVersion, setNotesByVersion] = React.useState<
    Record<string, readonly PendingNote[]>
  >({});
  const [draft, setDraft] = React.useState("");
  /** A refused send keeps what was typed and says why, here in the window. */
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const capture = React.useRef<((ids: readonly string[]) => Promise<AnnotationSpot[]>) | null>(
    null,
  );
  const snapshot = React.useRef<
    (() => Promise<{ html: string; values: Record<string, string> } | null>) | null
  >(null);
  /** The document has been changed by the person and not yet saved. Saving
   * is an explicit act — nothing becomes permanent until they say so, which
   * is what stops every keystroke being a version. */
  const [edited, setEdited] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);
  /** What a click means right now. Two things wanted the same click — ticking
   * a box and picking an element to write about — so which one it is, is a
   * choice rather than a guess. */
  const [mode, setMode] = React.useState<"use" | "markup">("use");
  const noteBox = React.useRef<HTMLTextAreaElement | null>(null);
  /** Where in the frame the selection sits, so the note box opens beside it
   * rather than in a panel at the bottom, away from what it is about. */
  const [selRect, setSelRect] = React.useState<SelectionRect | null>(null);
  const deselect = React.useRef<(() => void) | null>(null);
  /** What is typed, readable from a callback the frame holds. That callback
   * must keep its identity across keystrokes, so it cannot close over the
   * draft itself. */
  const draftRef = React.useRef("");
  /** Read from the hotkey callback, which must keep its identity. */
  const viewingOldRef = React.useRef(false);
  /** A batch of notes is on its way to the record. */
  const [sending, setSending] = React.useState(false);
  const sendingNotes = React.useRef(false);
  const queueSendRef = React.useRef<(() => Promise<void>) | null>(null);
  draftRef.current = draft;

  // Backing out. A selection with no way out of it was a dead end: the note
  // box stayed open over the document with nothing but Add note in it.
  const cancelNote = React.useCallback((): void => {
    setDraft("");
    setSelection([]);
    setSelRect(null);
    setRefusal(null);
    deselect.current?.();
  }, []);

  /** How wide the conversation is. Null means it has never been dragged, and
   * the stylesheet's own share of the window stands. */
  const [convWidth, setConvWidth] = React.useState<number | null>(() =>
    readConversationWidth(typeof localStorage === "undefined" ? null : localStorage),
  );
  const [dragging, setDragging] = React.useState(false);

  // A pointer capture, not a window listener: the pointer crosses the frame
  // on the way, and the frame is another document that would swallow every
  // move after the first.
  const startDrag = React.useCallback((e: React.PointerEvent<HTMLHRElement>): void => {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = grip.nextElementSibling?.getBoundingClientRect().width ?? 0;
    setDragging(true);

    const move = (ev: PointerEvent): void => {
      // Dragging left widens the conversation: it is the right-hand pane.
      setConvWidth(clampConversationWidth(startWidth - (ev.clientX - startX), window.innerWidth));
    };
    const done = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", done);
      grip.removeEventListener("pointercancel", done);
      grip.releasePointerCapture(e.pointerId);
      setDragging(false);
      setConvWidth((w) => {
        if (w !== null) writeConversationWidth(localStorage, w);
        return w;
      });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);
  }, []);

  // The address bar says what is on screen. Replaced rather than pushed:
  // moving between versions of a document is not a sequence of pages a person
  // wants to walk back through one at a time, and a pin that follows the
  // newest version would otherwise fill the history by itself.
  React.useEffect(() => {
    if (conversationId === "" || doc === null) return;
    const next: Route = {
      conversationId,
      artifactId: doc.artifactId,
      ...(pinned === null ? {} : { version: pinned }),
    };
    const now = parseRoute(window.location.pathname);
    if (sameRoute(now, next)) return;
    window.history.replaceState(null, "", formatRoute(next));
  }, [conversationId, doc, pinned]);

  // The same move without a pointer. A separator you can reach with Tab and
  // cannot operate is a control in name only.
  const nudgeDrag = React.useCallback((e: React.KeyboardEvent<HTMLHRElement>): void => {
    const step = e.shiftKey ? 64 : 16;
    const by = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
    if (by === 0) return;
    e.preventDefault();
    const now = e.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? 0;
    const next = clampConversationWidth(now + by, window.innerWidth);
    setConvWidth(next);
    writeConversationWidth(localStorage, next);
  }, []);

  // A window that shrinks can leave the conversation wider than there is
  // room for. What was dragged is kept; what is shown is what fits.
  React.useEffect(() => {
    const onResize = (): void => {
      setConvWidth((w) => (w === null ? null : clampConversationWidth(w, window.innerWidth)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const toggleMode = React.useCallback((): void => {
    // Nothing to switch between on a version that permits neither.
    if (viewingOldRef.current) return;
    setMode((m) => (m === "use" ? "markup" : "use"));
    // Leaving mark-up mode ends whatever note was being written: there is no
    // selection in use mode for it to point at.
    cancelNote();
  }, [cancelNote]);

  // Pressed anywhere in the page. The frame catches its own and posts them
  // out, so both work with the caret in the document too.
  const onHotkey = React.useCallback(
    (which: "toggle-mode" | "send-queue"): void => {
      if (which === "toggle-mode") {
        toggleMode();
        return;
      }
      // The note box has its own meaning for this key: add the note being
      // written to the queue. Once no note is being written, the same press
      // sends what the queue holds.
      if (queueSendRef.current === null) return;
      void queueSendRef.current();
    },
    [toggleMode],
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isModeToggle(e)) {
        e.preventDefault();
        onHotkey("toggle-mode");
        return;
      }
      if (!isQueueSend(e)) return;
      if (queueSendRef.current === null) return;
      e.preventDefault();
      onHotkey("send-queue");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onHotkey]);

  const onSelected = React.useCallback(
    (ids: readonly string[], rect: SelectionRect | null): void => {
      // Clicking a part of the document that is not addressable empties the
      // selection. With something already typed that threw the words away
      // and closed the box, with no undo. Backing out is Cancel or Escape;
      // a stray click is not either of them.
      if (ids.length === 0 && draftRef.current.trim() !== "") return;
      setSelection(ids);
      setSelRect(ids.length === 0 ? null : rect);
    },
    [],
  );

  // Selecting something in the document is the start of writing about it,
  // so the caret goes where the writing happens. Keyed on emptiness rather
  // than on the ids: adding a spot with ⌘-click should not pull focus back
  // out of a note being typed.
  const hasSelection = selection.length > 0;
  React.useEffect(() => {
    if (hasSelection) noteBox.current?.focus();
  }, [hasSelection]);

  const docKey = doc === null ? "" : `${doc.artifactId}@${doc.version}`;
  const notes = React.useMemo(() => notesByVersion[docKey] ?? [], [notesByVersion, docKey]);
  /** Work pending: something selected, something typed, or notes not sent.
   * lucid never changes version under a person who has work pending — that
   * is what makes replacing the whole frame safe, and why no attempt is made
   * to patch the document in place. */
  const pending = selection.length > 0 || draft.trim() !== "" || notes.length > 0 || edited;
  const pendingRef = React.useRef(false);
  React.useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  const setNotes = React.useCallback(
    (next: readonly PendingNote[]) => setNotesByVersion((prev) => ({ ...prev, [docKey]: next })),
    [docKey],
  );

  React.useEffect(() => {
    let alive = true;
    fetch("/api/session")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`session ${r.status}`))))
      .then((d: { token: string }) => {
        if (alive) setToken(d.token);
      })
      .catch((e: unknown) => {
        if (alive) setProblem(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    if (token === null || dead || conversationId === "") return;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
          headers: { [TOKEN_HEADER]: token },
        });
        if (!alive) return;
        if (res.status === 401) {
          setDead(true);
          setProblem("This page's token is no longer valid — the server restarted. Reload.");
          return;
        }
        if (!res.ok) {
          setProblem(`Could not read the conversation (${res.status}).`);
          return;
        }
        const data = (await res.json()) as {
          lines: Line[];
          status: string;
          damaged?: boolean;
          driver?: Driver;
          activity?: Activity;
        };
        if (!alive) return;
        const next = linesToMessages(data.lines);
        setMessages((prev) => {
          const changed =
            prev.length !== next.length ||
            (prev.length > 0 && prev[prev.length - 1]?.text !== next[next.length - 1]?.text);
          if (changed) setLastChange(Date.now());
          return next;
        });
        setStatus(data.status);
        setDriver(data.driver ?? {});
        setActivity(data.activity ?? { turn: false, inFlight: 0, waiting: 0 });
        setProblem(
          data.damaged === true
            ? "This record is damaged past a point; what follows the damage is not shown."
            : null,
        );
      } catch (e: unknown) {
        if (alive) setProblem(String(e));
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [token, dead, conversationId]);

  // The document channel. Separate effect, separate cadence, separate
  // endpoint — a document never rides along with a transcript poll.
  React.useEffect(() => {
    if (token === null || dead || conversationId === "") return;
    let alive = true;
    const tick = async (): Promise<void> => {
      if (fetching.current) return;
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/artifacts`,
          {
            headers: { [TOKEN_HEADER]: token },
          },
        );
        if (!alive || !res.ok) return;
        const body = (await res.json()) as {
          artifacts: CatalogEntry[];
          notes?: Record<string, Annotation[]>;
        };
        const artifacts = body.artifacts;
        // Held before the pick, not after it. An artifact the record does not
        // hold returns early below, and that is exactly the page that has to
        // offer the list of what it does hold.
        setAllArtifacts(artifacts);
        // The artifact the URL named, else the one with the most recent
        // version entry - which is what the page did when nothing could name
        // one. An id that names nothing is not silently replaced: the page
        // says so, because a link that quietly shows a different document is
        // worse than a link that fails.
        const asked = wantArtifact;
        const entry =
          asked === null
            ? artifacts[artifacts.length - 1]
            : artifacts.find((a) => a.artifactId === asked);
        if (entry === undefined) {
          if (asked !== null) setUnknownArtifact(asked);
          return;
        }
        setUnknownArtifact(null);
        setCatalog(entry);
        setSentNotes(body.notes ?? {});

        // The version asked for, else the newest. A pin is what makes an
        // older version reachable, and marks live on the version they were
        // made against, so that version has to be reachable.
        const target = pinned ?? entry.latest;
        const want = `${entry.artifactId}@${target}`;
        if (want === shown.current) {
          // Already on the asked-for version. A newer one having arrived is
          // news, not a reason to move.
          if (entry.latest > target) setWaiting(entry.latest);
          return;
        }
        if (pinned === null && pendingRef.current && shown.current !== "") {
          // Nothing pinned, but there is work in progress: say a newer
          // version exists and wait to be asked.
          setWaiting(entry.latest);
          return;
        }
        fetching.current = true;
        try {
          const one = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(entry.artifactId)}/${target}`,
            { headers: { [TOKEN_HEADER]: token } },
          );
          if (!alive || !one.ok) return;
          const fetched = (await one.json()) as Doc;
          if (!alive) return;
          shown.current = want;
          // A note addresses an element in the render it was made against,
          // so the selection and the draft do not carry across. Notes do:
          // they are held per version, and coming back finds them.
          setSelection([]);
          setSelRect(null);
          setDraft("");
          setRefusal(null);
          setWaiting(null);
          setEdited(false);
          setSaved(null);
          setDoc(fetched);
        } finally {
          fetching.current = false;
        }
      } catch {
        // A failed poll is not worth a notice: the next one is 2s away, and
        // the conversation channel already reports a server that has gone.
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), CATALOG_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [token, dead, conversationId, pinned, wantArtifact]);

  /** A restore waiting to be confirmed. Holding the version rather than a
   * boolean means the confirmation can name what it is about to do. */
  const [confirmRestore, setConfirmRestore] = React.useState<number | null>(null);
  const [restoring, setRestoring] = React.useState(false);

  /** Showing a version that is not the current one. Read-only: no editing,
   * no saving, no selecting, no annotating (RFC-07 R6, R7). */
  const viewingOld = doc !== null && catalog !== null && doc.version !== catalog.latest;

  const addNote = React.useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || selection.length === 0 || capture.current === null) return;
    // RFC-07 R10. Refused before anything is captured: what is queued stays
    // queued, and what was typed stays in the box to send after this one goes.
    // Belt as well as braces: the frame stops sending selections on a
    // read-only version, so this should be unreachable. It is here because
    // "should be unreachable" is where notes end up on the wrong version.
    if (viewingOld) return;
    const room = queueAdmits(notes.length);
    if (!room.ok) {
      setRefusal(room.why);
      return;
    }
    // What was on screen where the note points, captured now. A reference
    // would have to be resolved later, against a document that may have
    // changed by then.
    const spots = await capture.current(selection);
    if (spots.length === 0) return;
    // Three ways of finding each spot again, written now, against the
    // version being annotated — the same bytes the snapshot guard will
    // verify before any of them is trusted later.
    const parsed = new DOMParser().parseFromString(doc?.bytes ?? "", "text/html");
    const withSelectors = spots.map((sp) => {
      const sel = selectorsFor(parsed, sp.id);
      return sel === null ? sp : { ...sp, selectors: sel };
    });
    // Where in the timeline this happened, so it stays there when the
    // conversation carries on above and below it.
    setNotes([...notes, { note: text, spots: withSelectors, at: messages.length }]);
    setDraft("");
    setSelection([]);
    setSelRect(null);
    setRefusal(null);
    deselect.current?.();
  }, [draft, selection, notes, setNotes, doc, messages.length, viewingOld]);

  const sendNotes = React.useCallback(async (): Promise<void> => {
    if (notes.length === 0 || doc === null || token === null || dead) return;
    // One send at a time. There was no guard here at all, and the button was
    // greyed out by the document-save flag instead — two unrelated things
    // sharing one piece of state, so saving a document disabled sending
    // notes and sending notes showed nothing. A key that sends makes a
    // double press easy, which is what turned this up.
    if (sendingNotes.current) return;
    sendingNotes.current = true;
    setSending(true);
    try {
      // One request. Every note goes together, as one input with one id, one
      // disposition, and one turn.
      const body = encodeAnnotationBatch({
        artifactId: doc.artifactId,
        version: doc.version,
        notes: notes.map((n) => ({ note: n.note, spots: n.spots })),
      });
      const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/input`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        // Nothing is cleared: what was written is still there to send again.
        setRefusal(said.error === undefined ? `refused (${res.status})` : String(said.error));
        return;
      }
      setNotes([]);
      setRefusal(null);
    } finally {
      sendingNotes.current = false;
      setSending(false);
    }
  }, [notes, doc, token, dead, conversationId, setNotes]);

  // What command-Enter means right now, or null when it means nothing. A
  // ref, so the window listener and the frame's callback both read the
  // current answer without either being rebuilt as the queue changes.
  // Normally the note box owns this key: it adds the note being written. Once
  // the queue is full nothing can be added, so the key sends rather than doing
  // nothing at all - which is what it did, leaving a full queue, an open note
  // box, and no way out of either without reaching for the mouse.
  queueSendRef.current =
    notes.length > 0 && !sending && (selection.length === 0 || notes.length >= NOTE_QUEUE_MAX)
      ? sendNotes
      : null;

  const restore = React.useCallback(async (): Promise<void> => {
    const from = confirmRestore;
    if (from === null || doc === null || token === null || dead || restoring) return;
    setRestoring(true);
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/restore`,
        {
          method: "POST",
          headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ version: from }),
        },
      );
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        setRefusal(`not restored: ${said.error ?? res.status}`);
        return;
      }
      const body = (await res.json()) as { version: number };
      setConfirmRestore(null);
      setRefusal(null);
      // Follow what was just written. It is the current version now, and
      // staying on the old one would leave the page read-only for no reason
      // a person could see.
      setPinned(null);
      setSaved(`v${from} restored as v${body.version}`);
    } finally {
      setRestoring(false);
    }
  }, [confirmRestore, doc, token, dead, restoring, conversationId]);

  const save = React.useCallback(async (): Promise<void> => {
    if (doc === null || token === null || dead || snapshot.current === null) return;
    setSaving(true);
    try {
      const taken = await snapshot.current();
      if (taken === null) {
        setRefusal("could not read the document back");
        return;
      }
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/save`,
        {
          method: "POST",
          headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ html: taken.html, values: taken.values, basedOn: doc.version }),
        },
      );
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        // Nothing is cleared: the edit is still in the frame, and what was
        // typed is still here.
        setRefusal(
          said.error === "artifact-too-large"
            ? "too large to store — nothing was saved"
            : `not saved: ${said.error ?? res.status}`,
        );
        return;
      }
      const body = (await res.json()) as { version: number; supersededSince: boolean };
      setEdited(false);
      setRefusal(null);
      setSaved(
        body.supersededSince
          ? `saved as v${body.version}, based on v${doc.version} — the agent has since written a newer one`
          : `saved as v${body.version}`,
      );
      // Follow what was just written: it is the version being worked on now.
      setPinned(body.version);
    } finally {
      setSaving(false);
    }
  }, [doc, token, dead, conversationId]);

  // Re-anchoring. A note made against the version on screen already points
  // at an element there. One made against an earlier version has to be
  // found again — and only after that version's bytes verify against the
  // hash the record stored for them.
  const verified = React.useRef(new Map<string, boolean>());
  React.useEffect(() => {
    if (doc === null || token === null) return;
    let alive = true;
    void (async () => {
      const out: {
        note: string;
        fromVersion: number;
        elementId: string | null;
        how: Confidence | null;
        why: string | null;
        snippet: string;
      }[] = [];
      const target = new DOMParser().parseFromString(doc.bytes, "text/html");
      for (const [key, list] of Object.entries(sentNotes)) {
        const sep = key.lastIndexOf("@");
        if (sep === -1 || key.slice(0, sep) !== doc.artifactId) continue;
        const from = Number(key.slice(sep + 1));
        if (!Number.isSafeInteger(from)) continue;

        // Made against what is on screen: the ids still name the elements
        // they were written for, so nothing is resolved and nothing is
        // qualified.
        if (from === doc.version) {
          for (const n of list) {
            for (const sp of n.spots) {
              out.push({
                note: n.note,
                fromVersion: from,
                elementId: sp.id,
                how: null,
                why: null,
                snippet: sp.snippet,
              });
            }
          }
          continue;
        }

        // The snapshot guard. The selectors describe the bytes of the
        // version the note was made against, so those bytes are checked
        // before any selector is believed. Asked once per version.
        let ok = verified.current.get(key);
        if (ok === undefined) {
          try {
            const res = await fetch(
              `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/${from}`,
              { headers: { [TOKEN_HEADER]: token } },
            );
            if (res.ok) {
              const src = (await res.json()) as { bytes: string; hash: string };
              ok = (await sha256Hex(src.bytes)) === src.hash;
            } else {
              ok = false;
            }
          } catch {
            ok = false;
          }
          verified.current.set(key, ok);
        }
        if (!alive) return;

        for (const n of list) {
          // Each spot resolves on its own, and whichever survive are kept.
          for (const sp of n.spots) {
            const sel = sp.selectors as SpotSelectors | undefined;
            if (sel === undefined) {
              out.push({
                note: n.note,
                fromVersion: from,
                elementId: null,
                how: null,
                why: "no-selectors",
                snippet: sp.snippet,
              });
              continue;
            }
            // A note written against a LATER version than the one on
            // screen was never about this one. Resolving it backwards and
            // reporting "lost its target" said the agent had removed
            // something, when all that happened is that you looked at an
            // older version.
            if (from > doc.version) {
              out.push({
                note: n.note,
                fromVersion: from,
                elementId: null,
                how: null,
                why: "later-version",
                snippet: sp.snippet,
              });
              continue;
            }
            const r = resolveSpot(target, sel, ok === true);
            out.push(
              r.resolved
                ? {
                    note: n.note,
                    fromVersion: from,
                    elementId: r.elementId,
                    how: r.how,
                    why: null,
                    snippet: sp.snippet,
                  }
                : {
                    note: n.note,
                    fromVersion: from,
                    elementId: null,
                    how: null,
                    why: r.why,
                    snippet: sp.snippet,
                  },
            );
          }
        }
      }
      if (alive) setAnchored(out);
    })();
    return () => {
      alive = false;
    };
  }, [doc, sentNotes, token, conversationId]);

  const onNew = React.useCallback(
    async (m: { content: readonly { type: string; text?: string }[] }): Promise<void> => {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
      if (text.trim() === "" || token === null || dead) return;
      const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/input`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.status === 401) {
        setDead(true);
        setProblem("This page's token is no longer valid — the server restarted. Reload.");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setProblem(`Not sent: ${body.error ?? res.status}`);
      }
    },
    [conversationId, token, dead],
  );

  // A save is an artifact version entry, not an input, so it is not in the
  // transcript. The conversation still has to show that one happened — and
  // show that, never the document. Appended in version order: an artifact
  // entry carries no seq to interleave by, and a save is the most recent
  // thing its author did.
  const withSaves = React.useMemo(() => {
    const authors = catalog?.authors ?? {};
    const saves = Object.entries(authors)
      .filter(([, who]) => who === "human")
      .map(([v]) => Number(v))
      .sort((x, y) => x - y)
      .map((v) => ({
        id: `save-${catalog?.artifactId}-${v}`,
        role: "user" as const,
        text: `you saved ${catalog?.artifactId} v${v}`,
        note: true,
      }));
    return weaveNotes(saves.length === 0 ? messages : [...messages, ...saves], notes);
  }, [messages, catalog, notes]);

  const runtime = useExternalStoreRuntime<Msg>({
    messages: withSaves,
    setMessages: (next) => setMessages([...next]),
    onNew,
    convertMessage: (m: Msg) => ({
      id: m.id,
      role: m.role,
      content: [{ type: "text" as const, text: m.text }],
    }),
  });

  /** What to do next, in one line.
   *
   * The actions were discoverable only by trying them: three buttons whose
   * names said what they did and nothing about when they applied, and a
   * selection whose only feedback was inside a frame. This says which state
   * the page is in and what the next act is. */
  /** Keyed the way the batch line looks a note up: what it said, and what
   * it pointed at. */
  const resolutions = React.useMemo(() => {
    const m = new Map<string, { lost: boolean; later: boolean; how: string | null }>();
    for (const a of anchored) {
      m.set(`${a.note}\u0000${a.snippet}`, {
        lost: a.elementId === null && a.why !== "later-version",
        later: a.why === "later-version",
        how:
          a.how === null
            ? null
            : a.how === "exact"
              ? "found again, exactly"
              : a.how === "approximate"
                ? "found again, reworded"
                : a.how === "position"
                  ? "found by position"
                  : "found by path",
      });
    }
    return m;
  }, [anchored]);

  viewingOldRef.current = viewingOld;

  const guidance = ((): { text: string; tone: "idle" | "ready" | "warn" } => {
    if (doc === null) return { text: "No document in this conversation yet.", tone: "idle" };
    if (refusal !== null) return { text: refusal, tone: "warn" };
    // Said before anything else about the document, because it explains why
    // every other affordance is missing.
    if (viewingOld)
      return {
        text: `Version ${doc?.version} — read only. Only the current version can be edited or written about.`,
        tone: "warn",
      };
    if (edited) return { text: "You changed the document. Save to keep it.", tone: "ready" };
    // What the last save did. It was recorded and never shown, so a save the
    // server turned down looked exactly like one that worked.
    if (saved !== null)
      return { text: saved, tone: saved.startsWith("not saved") ? "warn" : "ready" };
    // The box is beside what it is about now, and it says what is selected.
    // Repeating that down here told the reader to look in the wrong place.
    if (selection.length > 0)
      return { text: "⌘-click to put more of the document in this note.", tone: "ready" };
    if (notes.length > 0)
      return {
        text: `${notes.length} note${notes.length === 1 ? "" : "s"} ready. ⌘⏎ sends them, or select more.`,
        tone: "ready",
      };
    if (mode === "markup")
      return {
        text: "Marking up: click a part of the document to select it, ⌘-click to add more. ⌥⌫ goes back to using it.",
        tone: "idle",
      };
    return {
      text: "Using the document: tick boxes, fill fields, and click text to edit it. ⌥⌫ switches to Mark up to write notes about it.",
      tone: "idle",
    };
  })();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Resolutions.Provider value={resolutions}>
        <header className="head">
          <span className="id">{conversationId === "" ? "no conversation" : conversationId}</span>
          {driver.harness === undefined ? null : (
            <span className="driver">
              {driver.harness}
              {driver.model === undefined ? "" : ` · ${driver.model}`}
              {driver.harnessVersion === undefined ? "" : ` · ${driver.harnessVersion}`}
            </span>
          )}
          <span className="status">{status}</span>
        </header>
        {problem === null ? null : <div className="notice">{problem}</div>}

        <div className="panes">
          {/* The document is the thing being worked on, so it gets the room
            and the left side. The conversation is the margin note. */}
          <div className="pane document">
            {unknownArtifact !== null ? (
              // A link naming an artifact this record does not hold. Said
              // plainly, with the way on, rather than quietly showing a
              // different document or rendering a blank frame.
              <div className="empty doc-empty">
                <p>This conversation has no artifact called “{unknownArtifact}”.</p>
                <AlsoHere
                  artifacts={allArtifacts}
                  showing={null}
                  conversationId={conversationId}
                  onOpen={openArtifact}
                />
                <button
                  type="button"
                  onClick={() => {
                    setWantArtifact(null);
                    setPinned(null);
                  }}
                >
                  Show what it does have
                </button>
              </div>
            ) : doc === null ? (
              <div className="empty doc-empty">
                Nothing to mark up yet. Ask the agent for a document.
              </div>
            ) : (
              <>
                <div className="doc-head">
                  <span className="doc-id">{doc.artifactId}</span>
                  <AlsoHere
                    artifacts={allArtifacts}
                    showing={doc.artifactId}
                    conversationId={conversationId}
                    onOpen={openArtifact}
                  />
                  {/* One version is a badge with nothing to open. More than
                    one is a dropdown, newest first: a row of buttons does not
                    survive a hundred versions, which is what a long
                    conversation produces. A native select because it is the
                    affordance, and the visual treatment belongs to the design
                    pass rather than to this. */}
                  {catalog === null || catalog.versions.length < 2 ? (
                    <span className="doc-version">v{doc.version}</span>
                  ) : (
                    <select
                      className={viewingOld ? "doc-version-pick old" : "doc-version-pick"}
                      value={String(doc.version)}
                      aria-label="Version"
                      onChange={(e) => {
                        const picked = Number.parseInt(e.target.value, 10);
                        // Choosing the current version is choosing to follow
                        // it, not to pin it there. Otherwise the newest
                        // version arriving would leave you on a stale one
                        // that the picker calls current.
                        setPinned(picked === catalog.latest ? null : picked);
                      }}
                    >
                      {[...catalog.versions].reverse().map((v) => (
                        <option key={v} value={String(v)}>
                          v{v}
                          {catalog.authors?.[v] === "human" ? " · saved by you" : " · by the agent"}
                          {v === catalog.latest ? " · current" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {pinned === null ? null : (
                    <button type="button" className="v latest" onClick={() => setPinned(null)}>
                      {viewingOld ? "Back to current" : "Follow newest"}
                    </button>
                  )}
                  {viewingOld ? (
                    <button
                      type="button"
                      className="v restore"
                      onClick={() => setConfirmRestore(doc.version)}
                      title={`Make v${doc.version} the current version`}
                    >
                      Restore this version
                    </button>
                  ) : null}
                  <span className="modes">
                    <button
                      type="button"
                      className={mode === "use" ? "m current" : "m"}
                      onClick={() => setMode("use")}
                      disabled={viewingOld}
                      title="Tick boxes, fill fields, and edit text (⌥⌫)"
                    >
                      Use
                    </button>
                    <button
                      type="button"
                      className={mode === "markup" ? "m current" : "m"}
                      onClick={() => setMode("markup")}
                      disabled={viewingOld}
                      title="Click parts of the document to write notes about them (⌥⌫)"
                    >
                      Mark up
                    </button>
                  </span>
                </div>

                {waiting === null || waiting <= doc.version ? null : (
                  <div className="doc-waiting">
                    Version {waiting} has arrived.{" "}
                    <button type="button" onClick={() => setPinned(waiting)}>
                      show it
                    </button>
                  </div>
                )}

                {/* The frame and the note box share one positioned box, so
                  a rect in the frame's own viewport is also a position on
                  this page and the anchor needs no arithmetic. */}
                <div className="doc-stage">
                  <DocumentFrame
                    doc={doc}
                    onSelection={onSelected}
                    capture={capture}
                    snapshot={snapshot}
                    deselect={deselect}
                    onHotkey={onHotkey}
                    onDirty={() => setEdited(true)}
                    marked={[
                      ...notes.flatMap((n) => n.spots.map((sp) => sp.id)),
                      ...anchored.flatMap((a) => (a.elementId === null ? [] : [a.elementId])),
                    ]}
                    mode={mode}
                    readOnly={viewingOld}
                  />

                  {/* Written where you clicked. The box used to be a panel at
                    the bottom of the pane, so the thing being written about
                    and the writing were at opposite ends of the screen. */}
                  <Popover.Root
                    open={selection.length > 0 && selRect !== null}
                    // Whether it is open is a fact about the selection, so
                    // the selection is the only thing that decides it. The
                    // library asked to close on any click outside and took
                    // a half-written note with it; refusing here means the
                    // ways out are Cancel, Escape, and Add note.
                    onOpenChange={() => {}}
                  >
                    <Popover.Anchor asChild>
                      <div
                        className="sel-anchor"
                        style={
                          selRect === null
                            ? { display: "none" }
                            : {
                                left: `${selRect.x}px`,
                                top: `${selRect.y}px`,
                                width: `${selRect.width}px`,
                                height: `${selRect.height}px`,
                              }
                        }
                      />
                    </Popover.Anchor>
                    <Popover.Portal>
                      <Popover.Content
                        className="note-pop"
                        // Under the line, not beside it. A block in a
                        // document is as wide as the column, so there is
                        // never room to the side — Radix said so, reporting
                        // 128px available, and the box hung off the screen.
                        // Below, it flips above near the bottom and slides
                        // sideways to stay in view.
                        side="bottom"
                        align="start"
                        // Stepped in from the left edge of what it points at.
                        // Flush, its edge lined up with the paragraph's and
                        // the two read as one block.
                        alignOffset={28}
                        sideOffset={8}
                        collisionPadding={12}
                        // Only Escape and the buttons close it. A click into
                        // the document is how a second spot is added, and it
                        // must not throw away what is already typed.
                        onInteractOutside={(e) => e.preventDefault()}
                        onFocusOutside={(e) => e.preventDefault()}
                        onEscapeKeyDown={cancelNote}
                        onOpenAutoFocus={(e) => {
                          e.preventDefault();
                          noteBox.current?.focus();
                        }}
                      >
                        <div className="note-pop-head">
                          {notes.length >= NOTE_QUEUE_MAX
                            ? `${NOTE_QUEUE_MAX} notes queued — send them before writing another`
                            : `${selection.length} selected${selection.length > 1 ? " — ⌘-click adds more" : ""}`}
                        </div>
                        <textarea
                          ref={noteBox}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              void addNote();
                            }
                          }}
                          placeholder={`What about ${selection.length === 1 ? "this" : `these ${selection.length}`}? (⌘⏎ to add)`}
                          rows={3}
                        />
                        <div className="note-pop-actions">
                          <button type="button" className="ghost" onClick={cancelNote}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void addNote()}
                            disabled={draft.trim() === "" || notes.length >= NOTE_QUEUE_MAX}
                          >
                            Add note
                          </button>
                        </div>
                        <Popover.Arrow className="note-pop-arrow" width={12} height={6} />
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                </div>

                {/* Everything below here has a fixed height and never scrolls
                  out of view. The actions were reachable only by scrolling a
                  panel that grew with the notes in it. */}
                {/* A confirmation, because a restore puts a new version in
                  front of the agent. It says the undo out loud: someone
                  deciding whether to restore is deciding whether it is
                  reversible, and here it is - permanently, because nothing
                  is overwritten. */}
                {confirmRestore === null ? null : (
                  <div className="confirm">
                    <span>
                      Make v{confirmRestore} the current version? It is copied to the end of the
                      list as v{(catalog?.latest ?? doc.version) + 1}. Nothing is deleted, and going
                      back is restoring v{catalog?.latest ?? doc.version} the same way.
                    </span>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void restore()}
                      disabled={restoring}
                    >
                      {restoring ? "Restoring…" : "Restore"}
                    </button>
                    <button type="button" onClick={() => setConfirmRestore(null)}>
                      Cancel
                    </button>
                  </div>
                )}

                <div className="doc-panel">
                  <div className={`guidance ${guidance.tone}`}>{guidance.text}</div>

                  <div className="note-actions">
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={!edited || saving || viewingOld}
                      title="Double-click text in the document to edit it; controls work as they are"
                    >
                      {saving ? "Saving…" : edited ? "Save changes" : "Saved"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* An `hr`, because that is what a separator is. It carries its
              width so a reader that cannot see the drag is still told what
              the arrow keys just did. */}
          <hr
            className={dragging ? "pane-grip dragging" : "pane-grip"}
            onPointerDown={startDrag}
            onKeyDown={nudgeDrag}
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize the conversation"
            aria-valuemin={CONVERSATION_MIN}
            aria-valuemax={CONVERSATION_MAX}
            aria-valuenow={convWidth ?? undefined}
          />

          <div
            className="pane conversation"
            style={
              convWidth === null
                ? undefined
                : ({ "--conversation-width": `${convWidth}px` } as React.CSSProperties)
            }
          >
            <Thread
              pending={notes}
              onSendNotes={() => void sendNotes()}
              onDiscardNotes={() => setNotes([])}
              sending={sending}
              activity={activity}
              quietFor={(now - lastChange) / 1000}
            />
          </div>
        </div>
      </Resolutions.Provider>
    </AssistantRuntimeProvider>
  );
};

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
