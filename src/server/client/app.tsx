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
import { ARTIFACT_TITLE_MAX } from "../../protocol/artifact-title.js";
import { type Activity as ActivitySnapshot, describeActivity } from "./activity.js";
import {
  type Confidence,
  resolveSpot,
  type SpotSelectors,
  selectorsFor,
  selectorsForQuote,
  sha256Hex,
} from "./anchor.js";
import { isModeToggle, isQueueSend } from "./hotkeys.js";
import { CaretDownDuotone, PencilDuotone } from "./icons.js";
import { ELEMENT_ID, FRAME_MESSAGE_SOURCE, instrumentArtifact } from "./instrument.js";
import {
  CONVERSATION_MAX,
  CONVERSATION_MIN,
  clampConversationWidth,
  readConversationWidth,
  writeConversationWidth,
} from "./layout.js";
import { diffLines } from "./line-diff.js";
import { formatRoute, parseRoute, type Route, sameRoute } from "./route.js";
import { type Msg, type PendingNote, type SentBatch, weaveNotes } from "./timeline.js";
import { diffVersions } from "./version-diff.js";
import { isReadOnly, versionState } from "./version-state.js";

/** Kept in step with the server's own poll interval. */
/** How wide a column must be for two of them to beat one.
 *
 * Policy, not measured: RFC-07 R9 names the number and says so. A line of
 * markup in a column narrower than this wraps so often that the comparison
 * is harder to read than the two versions separately. */
const COMPARE_COLUMN_MIN = 360;

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

/** The artifact's name, and renaming it in place.
 *
 * Renaming writes a title and never touches `artifactId`, so nothing that
 * points at the artifact moves: existing notes still resolve, and the
 * agent's next `replaces` still names the thing it means. It also writes no
 * version, so naming a document does not appear in its history as a change
 * to the document.
 *
 * The name is a button until you press it, and a field while you type. There
 * is no separate edit affordance to find, and nothing to dismiss when you
 * change your mind: Escape puts it back.
 */
const DocName = ({
  artifactId,
  title,
  onRename,
}: {
  artifactId: string;
  title?: string;
  onRename: (title: string) => Promise<string | null>;
}): React.ReactElement => {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const shown = displayName({ artifactId, ...(title === undefined ? {} : { title }) });

  const commit = async (): Promise<void> => {
    const next = draft.trim();
    // Renaming to what it already says, or to nothing, is not a rename.
    if (next === "" || next === shown) {
      setEditing(false);
      setProblem(null);
      return;
    }
    const why = await onRename(next);
    if (why !== null) {
      setProblem(why);
      return;
    }
    setEditing(false);
    setProblem(null);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="doc-id doc-rename"
        title={
          title === undefined
            ? `${artifactId} — click to name it`
            : `${artifactId} — click to rename`
        }
        onClick={() => {
          setDraft(shown);
          setProblem(null);
          setEditing(true);
        }}
      >
        {shown}
        {/* The affordance, on approach only: the name is the most
            prominent word in the bar and needs no standing label beside it. */}
        <span className="pencil">
          <PencilDuotone size={14} />
        </span>
      </button>
    );
  }
  return (
    <span className="doc-id doc-renaming">
      <input
        className="doc-rename-input"
        value={draft}
        // The stored bound. The field refuses the 201st character rather
        // than letting you type a name the endpoint will then reject.
        maxLength={ARTIFACT_TITLE_MAX}
        aria-label="Name this artifact"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
            setProblem(null);
          }
        }}
        onBlur={() => void commit()}
      />
      {problem === null ? null : <span className="doc-rename-problem">{problem}</span>}
    </span>
  );
};

/** What to call an artifact on screen.
 *
 * The id is the fallback, not a placeholder to be styled differently: an
 * artifact nobody has renamed is displayed by its id, and that is a complete
 * answer rather than a missing one. `artifactId` never moves, so this is the
 * only thing a rename changes. */
const displayName = (a: { readonly artifactId: string; readonly title?: string }): string =>
  a.title !== undefined && a.title !== "" ? a.title : a.artifactId;

/** What the frame reports for one pick, before it is stored.
 *
 * `quote` is the text a person dragged over, and it is deliberately not part
 * of `AnnotationSpot`: the record expresses it as `selectors.quote.exact`,
 * measured against the document's own bytes rather than against the frame's
 * instrumented copy. This carries it the short distance between the two. */
type CapturedSpot = AnnotationSpot & { readonly quote?: string };

/** `activity.ts` owns the shape and the rule that reads it. */
type Activity = ActivitySnapshot;

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
      ...(l.seq === undefined ? {} : { seq: l.seq }),
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
  ReadonlyMap<
    string,
    { lost: boolean; later: boolean; how: string | null; elementId: string | null }
  >
>(new Map());

/** Go to what a note points at.
 *
 * Context for the same reason `Resolutions` is: the message component is
 * handed to assistant-ui, which does the rendering, so nothing can be passed
 * down as a prop. `null` while no document is on screen. */
const FocusSpot = React.createContext<((ids: readonly string[]) => void) | null>(null);

const Message = (): React.ReactElement => {
  const resolutions = React.useContext(Resolutions);
  const focusSpot = React.useContext(FocusSpot);
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
            // Somewhere to go, and something to go there with. A lost note
            // and a note written against another version both stay inert:
            // there is no target, and scrolling somewhere arbitrary is worse
            // than not moving.
            // Every spot the note covers, in the order they were written.
            // A note can point at several elements and all of them are part
            // of what it is about.
            const targets = n.spots
              .map((sp) => resolutionFor(n.note, sp.snippet)?.elementId ?? null)
              .filter((id): id is string => id !== null);
            const canGo = focusSpot !== null && targets.length > 0;
            return (
              <div
                className={[
                  "note-card",
                  status?.lost === true ? "orphan" : status?.later === true ? "later" : "sent",
                  canGo ? "goes" : "",
                ]
                  .filter((c) => c !== "")
                  .join(" ")}
                key={`${n.note}:${spot?.id ?? ""}`}
                {...(canGo
                  ? {
                      role: "button" as const,
                      tabIndex: 0,
                      title: "Go to what this note is about",
                      onClick: () => focusSpot?.(targets),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          focusSpot?.(targets);
                        }
                      },
                    }
                  : {})}
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
/** A file attached to the message being written. Stored already - the hash
 * is the record's, not the page's - so the page holds a reference and a URL
 * to show it by, never a second copy of the bytes. */
interface Attached {
  readonly hash: string;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly text: boolean;
  /** An object URL for the thumbnail, or null for a file with no picture.
   *
   * An object URL rather than the endpoint's own: an `img` tag cannot send
   * the token header every `/api/` path requires, and putting a token in a
   * URL puts it in logs and referrers. The page fetches the bytes with the
   * header and shows what it already holds. */
  readonly url: string | null;
}

const Thread = ({
  pending,
  onSendNotes,
  onDiscardNotes,
  sending,
  activity,
  now,
  lastChange,
  attachments,
  onAttach,
  onRemoveAttachment,
}: {
  pending: readonly PendingNote[];
  onSendNotes: () => void;
  onDiscardNotes: () => void;
  sending: boolean;
  activity: Activity;
  /** Ticks once a second, so the count moves without a render loop. */
  now: number;
  /** When the transcript last changed. */
  lastChange: number;
  /** Files attached to the message being written, not yet sent. */
  attachments: readonly Attached[];
  onAttach: (files: FileList) => void;
  onRemoveAttachment: (hash: string) => void;
}): React.ReactElement => {
  const busyNow = activity.turn || activity.inFlight > 0 || activity.waiting > 0;
  // When this stretch of work began. Held across renders because nothing in
  // the record says it: a turn writes no line between its input and its
  // terminal event, so the only witness to the start is the page that saw
  // idle become busy. Adjusted during render, which is React's own form for
  // state derived from a change in props.
  const [wasBusy, setWasBusy] = React.useState(busyNow);
  const [startedAt, setStartedAt] = React.useState<number | null>(busyNow ? now : null);
  if (busyNow !== wasBusy) {
    setWasBusy(busyNow);
    setStartedAt(busyNow ? now : null);
  }
  // A turn that streams resets the clock as it goes; one that says nothing
  // until it finishes is timed from when it started.
  const since = Math.max(startedAt ?? now, lastChange);
  const report = describeActivity(activity, (now - since) / 1000);
  const { busy, stalled } = report;
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
              {report.label}
              {report.elapsed === null
                ? ""
                : stalled
                  ? ` — nothing back for ${report.elapsed}`
                  : ` — ${report.elapsed}`}
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

        {attachments.length === 0 ? null : (
          <div className="attached">
            {attachments.map((a) => (
              <span className={a.text ? "chip text" : "chip"} key={a.hash}>
                {/* A thumbnail for what has one; a name for what does not. The
                  bytes are already stored, so this reads them back rather
                  than holding a second copy in the page. */}
                {a.url !== null ? (
                  <img src={a.url} alt="" className="thumb" />
                ) : (
                  <span className="thumb kind">{a.text ? "text" : "file"}</span>
                )}
                <span className="chip-name">{a.name}</span>
                <button
                  type="button"
                  className="chip-drop"
                  title="Remove"
                  onClick={() => onRemoveAttachment(a.hash)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <ComposerPrimitive.Root className="composer">
          {/* Attaching and sending are separate: the file is stored the
            moment it is chosen, so closing the page does not lose it and
            sending is the ordinary act it already was. */}
          <label className="attach" title="Attach a file">
            +
            <input
              type="file"
              multiple
              onChange={(e) => {
                if (e.currentTarget.files !== null) onAttach(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
          </label>
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
  /** What to display. Absent from an older server and from an artifact
   * nobody has renamed, in which case the id is displayed (RFC-07 R11). */
  readonly title?: string;
  readonly versions: readonly number[];
  readonly latest: number;
  readonly authors?: Readonly<Record<number, string>>;
  /** Per version, the seq of the last line before it: where in the
   * conversation it belongs. Absent from an older server, in which case a
   * saved version has no place and is left out rather than guessed at. */
  readonly afterSeq?: Readonly<Record<number, number>>;
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
  focusSpot,
  place,
  restorePlace,
  pendingRestore,
  pendingPulse,
  pulseBlocks,
  goBlock,
  onOffscreen,
  onHotkey,
  onDirty,
  marked,
  mode,
  readOnly,
}: {
  doc: Doc;
  onSelection: (ids: readonly string[], rect: SelectionRect | null) => void;
  /** Handed the frame's answer to a capture request. */
  capture: React.MutableRefObject<((ids: readonly string[]) => Promise<CapturedSpot[]>) | null>;
  /** Handed the frame's answer to a snapshot request: the document as it now
   * reads, with lucid's instrumentation taken back out, and the values of
   * the controls the agent authored. */
  snapshot: React.MutableRefObject<
    (() => Promise<{ html: string; values: Record<string, string> } | null>) | null
  >;
  /** Handed a way to drop the frame's selection, for backing out of a note. */
  deselect: React.MutableRefObject<(() => void) | null>;
  focusSpot: React.MutableRefObject<((ids: readonly string[]) => void) | null>;
  place: React.MutableRefObject<{ version: number; index: number; top: number } | null>;
  restorePlace: React.MutableRefObject<((index: number, top: number) => void) | null>;
  pendingRestore: React.MutableRefObject<{ index: number; top: number } | null>;
  pendingPulse: React.MutableRefObject<readonly number[] | null>;
  pulseBlocks: React.MutableRefObject<((indexes: readonly number[]) => void) | null>;
  goBlock: React.MutableRefObject<((index: number) => void) | null>;
  onOffscreen: (indexes: readonly number[]) => void;
  /** A key the frame caught that means something to the whole page. */
  onHotkey: (which: "toggle-mode" | "send-queue") => void;
  /** The frame says when a person has changed something in it. */
  onDirty: () => void;
  /** Spots that already carry a note, marked in the document while the
   * batch is being composed. */
  marked: readonly string[];
  mode: "edit" | "annotate";
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
        m.kind !== "dirty" &&
        m.kind !== "place" &&
        m.kind !== "ready" &&
        m.kind !== "pulsed"
      )
        return;
      if (m.artifactId !== doc.artifactId || m.version !== doc.version) return;

      // Where the reader is, pushed by the frame as they scroll (#180).
      //
      // Pushed rather than asked for, because by the time it is needed the
      // frame that knew it has been unmounted. The version is recorded with
      // it: a place in v20 means nothing in v24 until it has been followed
      // through the versions between.
      // A fresh frame, holding the version that has just been taken up. If a
      // place was followed into it, this is the moment it can be given.
      if (m.kind === "ready") {
        const want = pendingRestore.current;
        if (want !== null) {
          pendingRestore.current = null;
          restorePlace.current?.(want.index, want.top);
        }
        // After the restore, never before it. What counts as already in view
        // is what the reader will be looking at, and until the place is put
        // back the frame is still at the top showing the wrong thing.
        const changed = pendingPulse.current;
        if (changed !== null) {
          pendingPulse.current = null;
          if (changed.length > 0) pulseBlocks.current?.(changed);
        }
        return;
      }

      // Which of them the reader could not see. The other half of the rule:
      // they did not pulse, so they are offered instead.
      if (m.kind === "pulsed") {
        onOffscreen(Array.isArray(m.offscreen) ? (m.offscreen as number[]) : []);
        return;
      }

      if (m.kind === "place") {
        if (typeof m.index !== "number" || typeof m.top !== "number") return;
        place.current = { version: doc.version, index: m.index, top: m.top };
        return;
      }
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
        const spots: CapturedSpot[] = [];
        for (const raw of m.spots) {
          if (raw === null || typeof raw !== "object") continue;
          const sp = raw as Record<string, unknown>;
          if (typeof sp.id !== "string" || !ELEMENT_ID.test(sp.id)) continue;
          if (typeof sp.snippet !== "string" || typeof sp.author !== "string") continue;
          spots.push({
            id: sp.id,
            snippet: clampSnippet(sp.snippet),
            author: sp.author,
            ...(typeof sp.quote === "string" && sp.quote !== "" ? { quote: sp.quote } : {}),
          });
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
  }, [
    doc.artifactId,
    doc.version,
    onSelection,
    onHotkey,
    onDirty,
    place,
    pendingRestore,
    restorePlace,
    pendingPulse,
    pulseBlocks,
    onOffscreen,
  ]);

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
    focusSpot.current = (ids) =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "focus", ids: [...ids] },
        "*",
      );
    restorePlace.current = (index, top) =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "restore-place", index, top },
        "*",
      );
    pulseBlocks.current = (indexes) =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "pulse", indexes: [...indexes] },
        "*",
      );
    goBlock.current = (index) =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "go-block", index },
        "*",
      );
    return () => {
      capture.current = null;
      snapshot.current = null;
      deselect.current = null;
      focusSpot.current = null;
      restorePlace.current = null;
      pulseBlocks.current = null;
      goBlock.current = null;
    };
  }, [capture, snapshot, deselect, focusSpot, restorePlace, pulseBlocks, goBlock]);

  React.useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      { source: FRAME_MESSAGE_SOURCE, kind: "mark", ids: [...marked] },
      "*",
    );
  }, [marked]);

  React.useEffect(() => {
    // Sent on a timer as well as on change: the frame is replaced whenever
    // the version changes, and a fresh frame starts in edit mode.
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
 * Two versions, side by side (RFC-07 R9).
 *
 * A comparison is a view and nothing else. It never reaches the agent, never
 * appends to the record, and offers no editing of either side - restoring
 * means leaving it first, which is deliberate: this is for reading, and
 * there is no write behind it.
 *
 * Two columns where each would have room, one below that. The switch follows
 * the room actually available rather than a stored preference or a guess at
 * the device, because the pane can be dragged to any width on any machine.
 */
const Comparison = ({
  left,
  right,
  leftVersion,
  rightVersion,
  onLeave,
}: {
  left: string | null;
  right: string | null;
  leftVersion: number;
  rightVersion: number;
  onLeave: () => void;
}): React.ReactElement => {
  const box = React.useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = React.useState(true);

  // Measured, not assumed. `COMPARE_COLUMN_MIN` is policy: below it a column
  // is too narrow to read a line of markup in, and two unreadable columns are
  // worse than one readable one.
  React.useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = (): void => setWide(el.clientWidth >= COMPARE_COLUMN_MIN * 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A version that could not be read is reported for its own side. Rendering
  // it as an empty column would say it was empty, which is a different and
  // untrue thing.
  const missing = left === null || right === null;
  const diff = React.useMemo(
    () => (missing ? null : diffLines(left as string, right as string)),
    [left, right, missing],
  );

  return (
    <div className={wide ? "compare wide" : "compare"} ref={box}>
      <div className="compare-head">
        <span>
          v{leftVersion} against v{rightVersion}
        </span>
        {diff === null ? null : (
          <span className="compare-count">
            {diff.identical
              ? "identical"
              : `${diff.added} added · ${diff.removed} removed · ${diff.changed} changed`}
            {diff.coarse ? " · too large to line up exactly" : ""}
          </span>
        )}
        <button type="button" onClick={onLeave}>
          Close
        </button>
      </div>

      {left === null ? (
        <div className="compare-unreadable">v{leftVersion} could not be read.</div>
      ) : null}
      {right === null ? (
        <div className="compare-unreadable">v{rightVersion} could not be read.</div>
      ) : null}

      {diff === null ? null : (
        <div className="compare-body">
          {diff.rows.map((r) => (
            <div
              className={`compare-row ${r.kind}`}
              key={`${r.kind}:${r.beforeNo ?? "-"}:${r.afterNo ?? "-"}`}
            >
              <span className="compare-no">{r.beforeNo ?? ""}</span>
              <pre className="compare-side left">{r.before ?? ""}</pre>
              <span className="compare-no">{r.afterNo ?? ""}</span>
              <pre className="compare-side right">{r.after ?? ""}</pre>
            </div>
          ))}
        </div>
      )}
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
  /** Go to the newest version even though there is work in progress.
   *
   * The banner offering the newer version used to call `setPinned(null)`,
   * and in the case it appears for, `pinned` is already `null` - nothing was
   * ever pinned. So the click changed no state, the guard below re-ran on the
   * same values, and the button did nothing at all.
   *
   * State rather than a ref, because the effect has to re-run when it is set
   * and has to read it. It is cleared as soon as it is honoured, so it asks
   * once rather than turning following back on for good. */
  const [forceFollow, setForceFollow] = React.useState(false);
  const goToNewest = React.useCallback(() => {
    // Both, because "show me the newest" has two things standing in its way
    // and either may be present. A pin holds the target at a chosen version;
    // work in progress holds the document where it is. Clearing only the pin
    // was the old behaviour and did nothing when nothing was pinned; setting
    // only the override does nothing when something is.
    setPinned(null);
    setForceFollow(true);
  }, []);
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
  const capture = React.useRef<((ids: readonly string[]) => Promise<CapturedSpot[]>) | null>(null);
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
   * choice rather than a guess.
   *
   * Annotate is the default. What a person does with a document an agent
   * produced is read it and say what is wrong with it; filling it in is the
   * rarer act, and it is the one that has a mode switch to reach it. */
  const [mode, setMode] = React.useState<"edit" | "annotate">("annotate");
  const noteBox = React.useRef<HTMLTextAreaElement | null>(null);
  /** Where in the frame the selection sits, so the note box opens beside it
   * rather than in a panel at the bottom, away from what it is about. */
  const [selRect, setSelRect] = React.useState<SelectionRect | null>(null);
  const deselect = React.useRef<(() => void) | null>(null);
  const focusSpot = React.useRef<((ids: readonly string[]) => void) | null>(null);
  /** The reader's place, as the frame last reported it. */
  const place = React.useRef<{ version: number; index: number; top: number } | null>(null);
  const restorePlace = React.useRef<((index: number, top: number) => void) | null>(null);
  /** A place followed into the version being taken up, waiting for its
   * frame to exist. */
  const pendingRestore = React.useRef<{ index: number; top: number } | null>(null);
  /** Blocks this version changed that the reader could not see. They did
   * not pulse, so they are offered instead. */
  const [offscreenChanges, setOffscreenChanges] = React.useState<readonly number[]>([]);
  /** Files attached to the message being written. Stored the moment they are
   * chosen, so closing the page does not lose them. */
  const [attached, setAttached] = React.useState<readonly Attached[]>([]);
  /** Files on the note being written. Separate from the composer's: a note is
   * about a spot, and its files are about that note. */
  const [noteFiles, setNoteFiles] = React.useState<readonly Attached[]>([]);
  /** A comparison being read: which version the one on screen is held against,
   * and that version's bytes once they arrive. `null` bytes mean it could not
   * be read, which is reported rather than shown as an empty side. */
  const [comparing, setComparing] = React.useState<{
    version: number;
    bytes: string | null;
    loading: boolean;
  } | null>(null);
  const docRef = React.useRef<Doc | null>(null);
  /** Blocks this version added or changed, waiting for its frame. Sent once:
   * the pulse marks a version arriving, not a block existing. */
  const pendingPulse = React.useRef<readonly number[] | null>(null);
  const pulseBlocks = React.useRef<((indexes: readonly number[]) => void) | null>(null);
  const goBlock = React.useRef<((index: number) => void) | null>(null);
  /** What is typed, readable from a callback the frame holds. That callback
   * must keep its identity across keystrokes, so it cannot close over the
   * draft itself. */
  const draftRef = React.useRef("");
  /** Read from the hotkey callback, which must keep its identity. */
  /** Read only, for the hotkey path. Fed from `pinnedOld`: being
   * overtaken does not take the modes away. */
  const viewingOldRef = React.useRef(false);
  const editedRef = React.useRef(false);
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

  /* Closing the tab, reloading, or following a link takes the frame with it,
   * and the frame is where an unsaved edit lives - nothing has written it
   * down yet. Every other way of losing it now asks first: a version
   * arriving offers save-or-discard, and a mode switch keeps it. This was
   * the one exit with no question on it.
   *
   * The browser shows its own wording and ignores ours, so there is no
   * message here. `preventDefault` is what asks. */
  React.useEffect(() => {
    if (!edited) return;
    const ask = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [edited]);

  const toggleMode = React.useCallback((): void => {
    // Nothing to switch between on a version that permits neither, and
    // nothing to switch to while the bar is asking to save or discard.
    if (viewingOldRef.current || editedRef.current) return;
    setMode((m) => (m === "edit" ? "annotate" : "edit"));
    // Leaving annotate mode ends whatever note was being written: there is no
    // selection in edit mode for it to point at.
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
        if (pinned === null && pendingRef.current && shown.current !== "" && !forceFollow) {
          // Nothing pinned, but there is work in progress: say a newer
          // version exists and wait to be asked. `forceFollow` is that asking.
          setWaiting(entry.latest);
          return;
        }
        // Asked for, so spent. Anything after this holds the document again
        // the moment there is work in progress.
        if (forceFollow) setForceFollow(false);
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

          // Follow the reader's place into the version being taken up (#180).
          //
          // By block, not by scroll offset. An offset is wrong the moment
          // anything above the reader changes length, which is exactly what
          // a new version does. `carried` is the same walk that reports what
          // changed, read for where things went rather than what they are.
          //
          // Only when the place belongs to the version being left. A place
          // in v20 says nothing about v24, and following it through every
          // version between is work nobody asked for - the reader who was
          // not here does not need their seat kept.
          pendingRestore.current = null;
          pendingPulse.current = null;
          setOffscreenChanges([]);
          const here = place.current;
          const leaving = docRef.current;
          // One walk answers both questions - where the reader's block went,
          // and what this version changed. They are the same comparison read
          // two ways.
          if (leaving !== null) {
            try {
              const parse = (html: string): Document =>
                new DOMParser().parseFromString(html, "text/html");
              const d = diffVersions(parse(leaving.bytes), parse(fetched.bytes));

              if (here !== null && here.version === leaving.version) {
                const moved = d.carried.get(here.index);
                // Absent means the block the reader was on is gone. Putting
                // them somewhere else that happens to share its number is
                // worse than the top, which is at least honest.
                if (moved !== undefined) pendingRestore.current = { index: moved, top: here.top };
              }

              // What arrived, by its place in the version that arrived. A
              // removed block has nowhere to pulse, so it is not here.
              const touched: number[] = [];
              for (const c of d.changes) {
                if (c.at !== undefined) touched.push(c.at);
              }
              pendingPulse.current = touched;
            } catch {
              // Both of these are conveniences. Failing at them must never
              // stop the version arriving.
            }
          }
          place.current = null;

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
  }, [token, dead, conversationId, pinned, wantArtifact, forceFollow]);

  /** A restore waiting to be confirmed. Holding the version rather than a
   * boolean means the confirmation can name what it is about to do. */
  const [confirmRestore, setConfirmRestore] = React.useState<number | null>(null);
  /** A newer version waiting to be shown, once it is confirmed that the
   * unsaved edit can go. Holds the version so the confirmation can name it. */
  const [confirmDiscard, setConfirmDiscard] = React.useState<number | null>(null);
  /** An unsaved edit waiting to be thrown away on purpose. Separate from
   * `confirmDiscard`, which is about going to a newer version: this one is
   * just abandoning what was typed, with nowhere to go afterwards. */
  const [confirmDiscardEdit, setConfirmDiscardEdit] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);

  /** Showing a version that is not the current one. Read-only: no editing,
   * no saving, no selecting, no annotating (RFC-07 R6, R7). */
  /** Not the newest version. Two situations wear this, and they are not the
   * same situation.
   *
   * `pinnedOld` is going back deliberately: a version was chosen from the
   * picker. It is read only, and everything that reads "you cannot change
   * this" belongs to it.
   *
   * `overtaken` is standing still while the newest moved. Nothing was
   * chosen - the agent wrote a version, and the document was held where it
   * was because there was work in progress. Treating that as read only
   * disabled the save on an edit that was still live, and the server's whole
   * superseded-save path (`basedOn`, `supersededSince`) exists for exactly
   * this and could not be reached from the page. */
  const shownVersion = versionState({
    shown: doc?.version ?? null,
    latest: catalog?.latest ?? null,
    pinned,
  });
  const pinnedOld = isReadOnly(shownVersion);
  const overtaken = shownVersion === "overtaken";
  /** Not the newest, either way. Cosmetic only - what the picker looks like,
   * and what the follow button says. Never what is disabled. */
  const viewingOld = shownVersion !== "current";

  const addNote = React.useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || selection.length === 0 || capture.current === null) return;
    // RFC-07 R10. Refused before anything is captured: what is queued stays
    // queued, and what was typed stays in the box to send after this one goes.
    // Belt as well as braces: the frame stops sending selections on a
    // read-only version, so this should be unreachable. It is here because
    // "should be unreachable" is where notes end up on the wrong version.
    if (pinnedOld) return;
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
    const withSelectors = spots.map(({ quote, ...sp }) => {
      // A drag anchors to the words dragged over; a click anchors to the
      // whole element. `quote` is dropped here either way: what is stored is
      // the anchor it produced, not the raw report from the frame.
      const sel =
        quote === undefined || quote === ""
          ? selectorsFor(parsed, sp.id)
          : selectorsForQuote(parsed, sp.id, quote);
      return sel === null ? sp : { ...sp, selectors: sel };
    });
    // Where in the timeline this happened, so it stays there when the
    // conversation carries on above and below it.
    setNotes([
      ...notes,
      {
        note: text,
        spots: withSelectors,
        at: messages.length,
        // The reference travels with the note, never the bytes. `path` is
        // filled in when the turn is built, because where a file is offered
        // from is a per-turn copy outside the record.
        ...(noteFiles.length === 0
          ? {}
          : {
              files: noteFiles.map((f) => ({
                hash: f.hash,
                bytes: f.bytes,
                contentType: f.contentType,
                name: f.name,
              })),
            }),
      },
    ]);
    setNoteFiles([]);
    setDraft("");
    setSelection([]);
    setSelRect(null);
    setRefusal(null);
    deselect.current?.();
  }, [draft, selection, notes, setNotes, doc, messages.length, pinnedOld, noteFiles]);

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
        notes: notes.map((n) => ({
          note: n.note,
          spots: n.spots,
          ...(n.files === undefined || n.files.length === 0 ? {} : { files: n.files }),
        })),
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

  /** Write a title. Returns null on success, or why not, so the field can
   * stay open with the reason beside it rather than closing and losing what
   * was typed. */
  const rename = React.useCallback(
    async (title: string): Promise<string | null> => {
      if (doc === null || token === null || dead) return "not connected";
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/meta`,
        {
          method: "POST",
          headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ title }),
        },
      );
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        return said.error === "invalid-title"
          ? `a name is 1 to ${ARTIFACT_TITLE_MAX} characters, with no control characters`
          : `not renamed: ${said.error ?? res.status}`;
      }
      // The catalog is what the header reads, and the poll refreshes it. Set
      // it now so the name does not flicker back to the id for a tick.
      setAllArtifacts((prev) =>
        prev.map((a) => (a.artifactId === doc.artifactId ? { ...a, title } : a)),
      );
      return null;
    },
    [doc, token, dead, conversationId],
  );

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

  /** Read another version, to hold this one against it.
   *
   * Read-only in every sense: it fetches bytes and puts them on screen. No
   * frame is made for it, so neither side can be edited, and nothing about a
   * comparison reaches the record or the agent. */
  const compareWith = React.useCallback(
    async (version: number): Promise<void> => {
      if (doc === null || token === null) return;
      setComparing({ version, bytes: null, loading: true });
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/${version}`,
          { headers: { [TOKEN_HEADER]: token } },
        );
        if (!res.ok) {
          setComparing({ version, bytes: null, loading: false });
          return;
        }
        const other = (await res.json()) as Doc;
        setComparing({ version, bytes: other.bytes, loading: false });
      } catch {
        // Reported on its own side of the comparison, not as a page failure.
        setComparing({ version, bytes: null, loading: false });
      }
    },
    [doc, token, conversationId],
  );

  /** Store a chosen file and describe it back. Shared by the composer and
   * the note box, because storing is the same act either way - only what the
   * reference is then attached to differs. */
  const storeFiles = React.useCallback(
    async (files: FileList): Promise<readonly Attached[]> => {
      if (token === null || conversationId === "") return [];
      const out: Attached[] = [];
      for (const file of Array.from(files)) {
        try {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
            {
              method: "POST",
              headers: {
                [TOKEN_HEADER]: token,
                "x-lucid-filename": file.name,
                "content-type": file.type === "" ? "application/octet-stream" : file.type,
              },
              body: file,
            },
          );
          if (!res.ok) {
            const said = (await res.json().catch(() => ({}))) as { error?: string };
            setRefusal(
              said.error === "attachment-too-large"
                ? `${file.name} is too large to attach`
                : `could not attach ${file.name}: ${said.error ?? res.status}`,
            );
            continue;
          }
          const a = (await res.json()) as Omit<Attached, "url">;
          let url: string | null = null;
          if (a.contentType.startsWith("image/")) {
            const got = await fetch(
              `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${a.hash}`,
              { headers: { [TOKEN_HEADER]: token } },
            );
            if (got.ok) {
              const blob = await got.blob();
              if (blob.type.startsWith("image/")) url = URL.createObjectURL(blob);
            }
          }
          out.push({ ...a, url });
        } catch (e) {
          setRefusal(`could not attach ${file.name}: ${String(e)}`);
        }
      }
      return out;
    },
    [token, conversationId],
  );

  const attachToNote = React.useCallback(
    async (files: FileList): Promise<void> => {
      const stored = await storeFiles(files);
      setNoteFiles((prev) => [
        ...prev,
        ...stored.filter((a) => !prev.some((p) => p.hash === a.hash)),
      ]);
    },
    [storeFiles],
  );

  const removeNoteFile = React.useCallback((hash: string): void => {
    setNoteFiles((prev) => {
      const going = prev.find((a) => a.hash === hash);
      if (going?.url !== null && going?.url !== undefined) URL.revokeObjectURL(going.url);
      return prev.filter((a) => a.hash !== hash);
    });
  }, []);

  const attachFiles = React.useCallback(
    async (files: FileList): Promise<void> => {
      if (token === null || conversationId === "") return;
      for (const file of Array.from(files)) {
        try {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
            {
              method: "POST",
              headers: {
                [TOKEN_HEADER]: token,
                "x-lucid-filename": file.name,
                "content-type": file.type === "" ? "application/octet-stream" : file.type,
              },
              body: file,
            },
          );
          if (!res.ok) {
            const said = (await res.json().catch(() => ({}))) as { error?: string };
            setRefusal(
              said.error === "attachment-too-large"
                ? `${file.name} is too large to attach`
                : `could not attach ${file.name}: ${said.error ?? res.status}`,
            );
            continue;
          }
          const a = (await res.json()) as Omit<Attached, "url">;
          // Only a picture needs one, and only the page can make one: the
          // bytes come back over a request that carries the token, and the
          // object URL is what an `img` can actually use.
          let url: string | null = null;
          if (a.contentType.startsWith("image/")) {
            const got = await fetch(
              `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${a.hash}`,
              { headers: { [TOKEN_HEADER]: token } },
            );
            if (got.ok) {
              const blob = await got.blob();
              // Served as an image only when the BYTES say so, so a file that
              // claimed to be a picture and is not comes back as bytes and
              // gets no thumbnail rather than a broken one.
              if (blob.type.startsWith("image/")) url = URL.createObjectURL(blob);
            }
          }
          setAttached((prev) =>
            prev.some((p) => p.hash === a.hash) ? prev : [...prev, { ...a, url }],
          );
        } catch (e) {
          setRefusal(`could not attach ${file.name}: ${String(e)}`);
        }
      }
    },
    [token, conversationId],
  );

  /** Take it off the message. The bytes stay in the record - nothing removes
   * anything from a record - and this is the message forgetting it. */
  const removeAttachment = React.useCallback((hash: string): void => {
    setAttached((prev) => {
      // The object URL holds the bytes in the page until it is revoked.
      const going = prev.find((a) => a.hash === hash);
      if (going?.url !== null && going?.url !== undefined) URL.revokeObjectURL(going.url);
      return prev.filter((a) => a.hash !== hash);
    });
  }, []);

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
      // Follow, do not pin. What was just saved IS the newest version, so
      // following shows it - and keeps showing the newest one after that.
      //
      // Pinning here looked equivalent and was not. The version you saved
      // stops being current the moment the agent answers, and a version that
      // is not current is read only, so saving and then asking the agent for
      // anything locked you out of your own document with no explanation
      // beyond a small line offering the new version.
      setPinned(null);
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
    // A version this person saved is a moment in the conversation, so it is
    // shown where it happened. It used to be appended after every message,
    // which put a save from yesterday below an answer from a minute ago and
    // made it read as something that had just occurred.
    //
    // An artifact entry carries no seq of its own - the fold does not reduce
    // one into state - so the fold records the seq of the last line before
    // it, and that is the place. A version with no place, from a server that
    // does not send one, is left out rather than guessed at: a marker in the
    // wrong place is worse than no marker.
    const authors = catalog?.authors ?? {};
    const afterSeq = catalog?.afterSeq ?? {};
    const placed = Object.entries(authors)
      .filter(([, who]) => who === "human")
      .map(([v]) => Number(v))
      .filter((v) => typeof afterSeq[v] === "number")
      .sort((x, y) => x - y)
      .map((v) => ({
        after: afterSeq[v] as number,
        line: {
          id: `save-${catalog?.artifactId}-${v}`,
          role: "user" as const,
          text: `you saved ${catalog?.artifactId} v${v}`,
          note: true,
        },
      }));

    if (placed.length === 0) return weaveNotes(messages, notes);

    const woven: Msg[] = [];
    let next = 0;
    for (const m of messages) {
      // Every save whose place is at or before this line goes in first.
      while (next < placed.length && (placed[next]?.after ?? 0) < (m.seq ?? 0)) {
        woven.push(placed[next++]?.line as Msg);
      }
      woven.push(m);
    }
    while (next < placed.length) woven.push(placed[next++]?.line as Msg);
    return weaveNotes(woven, notes);
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
    const m = new Map<
      string,
      { lost: boolean; later: boolean; how: string | null; elementId: string | null }
    >();
    for (const a of anchored) {
      m.set(`${a.note}\u0000${a.snippet}`, {
        lost: a.elementId === null && a.why !== "later-version",
        later: a.why === "later-version",
        // What the note points at in the version on screen. Already resolved
        // - it is what decides the "found again, exactly" line below - so
        // going there needs no second search.
        elementId: a.elementId,
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

  viewingOldRef.current = pinnedOld;
  // The save bar hides the mode control while an edit is pending, so the
  // hotkey goes with it. A key that still worked would be an unlabelled
  // way past a bar whose whole claim is that there are two things to do.
  editedRef.current = edited;
  // The version on screen, for readers that must not re-run when it
  // changes. The document channel is one: making it depend on `doc`
  // would restart a fetching effect every time a fetch finished.
  docRef.current = doc;

  const guidance = ((): { text: string; tone: "idle" | "ready" | "warn" } => {
    if (doc === null) return { text: "No document in this conversation yet.", tone: "idle" };
    if (refusal !== null) return { text: refusal, tone: "warn" };
    // Said before anything else about the document, because it explains why
    // every other affordance is missing.
    if (pinnedOld)
      return {
        text: `Version ${doc?.version} — read only. Only the current version can be edited or written about.`,
        tone: "warn",
      };
    // Being overtaken is not read only, so it does not take this branch. An
    // edit in progress keeps saying what it says, and the banner above the
    // document is what reports the newer version.
    if (edited)
      return {
        text: overtaken
          ? "You changed the document. Save to keep it — it will land on top of the newer version."
          : "You changed the document. Save to keep it.",
        tone: "ready",
      };
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
    if (mode === "annotate")
      return {
        text: "Annotating: click a part of the document to select it, ⌘-click to add more. ⌥⌫ goes back to editing it.",
        tone: "idle",
      };
    return {
      text: "Editing the document: tick boxes, fill fields, and click text to change it. ⌥⌫ switches to Annotate to write notes about it.",
      tone: "idle",
    };
  })();

  /** Handed to every note card. Refuses while an older version is pinned:
   * the note's target was resolved against what is on screen, and jumping
   * inside a version the note was not written against points at the wrong
   * place rather than at nothing. */
  const goToSpot = React.useCallback(
    (ids: readonly string[]) => {
      if (pinnedOld) return;
      focusSpot.current?.(ids);
    },
    [pinnedOld],
  );

  /** The conversation's status pill, in one word. The counted, clocked
   * telling of this state is a later stage's; the pill says which of the two
   * states holds. */
  const busy = activity.turn || activity.inFlight > 0 || activity.waiting > 0;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Resolutions.Provider value={resolutions}>
        <FocusSpot.Provider value={goToSpot}>
          {problem === null ? null : (
            <div className="notice" role="alert">
              {problem}
            </div>
          )}

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
                  {/* A conversation holds one artifact, so there is one thing
                    to offer and it is named. This is what the list used to
                    do for this page; without a replacement, saying the
                    artifact does not exist and offering nothing makes the
                    page a dead end. */}
                  {allArtifacts.length === 0 ? (
                    <p>It has no artifact yet. Ask the agent for a document.</p>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => openArtifact((allArtifacts[0] as CatalogEntry).artifactId)}
                    >
                      Open “{displayName(allArtifacts[0] as CatalogEntry)}”
                    </button>
                  )}
                </div>
              ) : doc === null ? (
                <div className="empty doc-empty">
                  Nothing to annotate yet. Ask the agent for a document.
                </div>
              ) : (
                <>
                  {/* App Bridge, as #171 settled it: with an unsaved edit the
                    bar stops describing the document and becomes the question,
                    and nothing else. The name, the version and the modes are
                    not merely disabled but gone - the only two things there
                    are to do are the two that are here.
                    
                    Discard confirms. It is the only control on this bar that
                    destroys work, and lucid asks before losing what a person
                    typed everywhere else too. */}
                  {edited ? (
                    <div className="doc-head saving-bar">
                      <span className="saving-what">
                        Unsaved changes
                        {overtaken ? " — they will land on top of the newer version" : ""}
                      </span>
                      <button
                        type="button"
                        className="v"
                        onClick={() => setConfirmDiscardEdit(true)}
                        disabled={saving}
                      >
                        Discard
                      </button>
                      <button
                        type="button"
                        className="v primary"
                        onClick={() => void save()}
                        disabled={saving}
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  ) : (
                    <div className="doc-head">
                      {/* lucid, over the document: the mark, a hairline, then
                      the name. Nothing else above the sheet. */}
                      <span className="doc-mark" aria-hidden="true">
                        <span className="dot" />
                        <span className="word">lucid</span>
                      </span>
                      <span className="doc-head-sep" aria-hidden="true" />
                      <DocName
                        artifactId={doc.artifactId}
                        {...(allArtifacts.find((a) => a.artifactId === doc.artifactId)?.title ===
                        undefined
                          ? {}
                          : {
                              title: allArtifacts.find((a) => a.artifactId === doc.artifactId)
                                ?.title as string,
                            })}
                        onRename={rename}
                      />
                      {/* One version is a badge with nothing to open. More than
                    one is the version pill: its closed state is the design's,
                    and the invisible select over it opens the native dropdown.
                    A hundred versions is a hundred buttons otherwise, and a
                    long conversation produces a hundred versions. */}
                      {catalog === null || catalog.versions.length < 2 ? (
                        <span className="doc-version">v{doc.version}</span>
                      ) : (
                        <span className="doc-version-pill">
                          <span className="v">v{doc.version}</span>
                          {viewingOld ? null : (
                            <span className="of">latest of {catalog.versions.length}</span>
                          )}
                          <span className="caret" aria-hidden="true">
                            <CaretDownDuotone />
                          </span>
                          <select
                            className="pill-select"
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
                                {catalog.authors?.[v] === "human"
                                  ? " · saved by you"
                                  : " · by the agent"}
                                {v === catalog.latest ? " · current" : ""}
                              </option>
                            ))}
                          </select>
                        </span>
                      )}
                      {/* Offered only where there is something to compare
                      against: one version has nothing to be held against. */}
                      {catalog === null || catalog.versions.length < 2 ? null : (
                        <select
                          className="compare-pick"
                          value=""
                          aria-label="Compare with another version"
                          onChange={(e) => {
                            const v = Number.parseInt(e.target.value, 10);
                            if (Number.isSafeInteger(v)) void compareWith(v);
                            e.currentTarget.value = "";
                          }}
                        >
                          <option value="">Compare with…</option>
                          {catalog.versions
                            .filter((v) => v !== doc.version)
                            .map((v) => (
                              <option key={v} value={String(v)}>
                                v{v}
                              </option>
                            ))}
                        </select>
                      )}
                      {pinned === null ? null : (
                        <button type="button" className="v latest" onClick={() => setPinned(null)}>
                          {viewingOld ? "Back to current" : "Follow newest"}
                        </button>
                      )}
                      {pinnedOld ? (
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
                          className={mode === "annotate" ? "m current" : "m"}
                          onClick={() => setMode("annotate")}
                          disabled={pinnedOld}
                          title="Click parts of the document to write notes about them (⌥⌫)"
                        >
                          Annotate
                        </button>
                        <button
                          type="button"
                          className={mode === "edit" ? "m current" : "m"}
                          onClick={() => setMode("edit")}
                          disabled={pinnedOld}
                          title="Tick boxes, fill fields, and edit text (⌥⌫)"
                        >
                          Edit
                        </button>
                      </span>
                    </div>
                  )}

                  {/* The other half of the update-location rule (#181). What
                  the reader could see pulsed and is not mentioned; what they
                  could not see did not pulse and is offered here. Saying
                  both would be saying it twice. */}
                  {offscreenChanges.length === 0 ? null : (
                    <div className="doc-changed">
                      {offscreenChanges.length} change
                      {offscreenChanges.length === 1 ? "" : "s"} you cannot see.{" "}
                      <button
                        type="button"
                        onClick={() => {
                          const first = offscreenChanges[0];
                          if (first !== undefined) goBlock.current?.(first);
                          setOffscreenChanges([]);
                        }}
                      >
                        show the first
                      </button>
                    </div>
                  )}

                  {waiting === null || waiting <= doc.version ? null : (
                    <div className="doc-waiting">
                      Version {waiting} has arrived.{" "}
                      {/* Going there replaces the whole frame, so an unsaved
                      edit in it would go with no warning. Saving first is
                      offered because it works: the save lands on top of the
                      newer version and follows it afterwards. */}
                      {edited ? (
                        <>
                          <button type="button" onClick={() => void save()} disabled={saving}>
                            {saving ? "Saving…" : "save mine first"}
                          </button>{" "}
                          <button type="button" onClick={() => setConfirmDiscard(waiting)}>
                            discard mine and show it
                          </button>
                        </>
                      ) : (
                        /* Follow rather than pin, for the reason the save path
                        gives: pinning to the newest version now means being
                        read-only against the one after it. */
                        <button type="button" onClick={goToNewest}>
                          show it
                        </button>
                      )}
                    </div>
                  )}

                  {/* A comparison covers the stage rather than replacing the
                    pane, so leaving it returns to the version that was being
                    read, exactly where it was. */}
                  {comparing === null ? null : (
                    <Comparison
                      left={comparing.bytes}
                      right={doc.bytes}
                      leftVersion={comparing.version}
                      rightVersion={doc.version}
                      onLeave={() => setComparing(null)}
                    />
                  )}

                  {/* The patterned ground behind the sheet: sepia and the
                  Topography pattern to annotate on, Graph Paper to edit on.
                  It bleeds to the window's left, right, and bottom edges and
                  never above the header. */}
                  <div className={mode === "edit" ? "doc-ground edit" : "doc-ground"}>
                    {/* The frame and the note box share one positioned box, so
                  a rect in the frame's own viewport is also a position on
                  this page and the anchor needs no arithmetic. The box is
                  the sheet: --paper, the mode's 1px border, radius 12px. */}
                    <div className="doc-stage">
                      {/* The tab on the sheet's top edge carries the mode. An
                    indicator only - the toggle in the header is the control. */}
                      <div className="doc-tab" aria-hidden="true">
                        {mode === "edit" ? "Edit" : "Annotate"}
                      </div>
                      <DocumentFrame
                        doc={doc}
                        onSelection={onSelected}
                        capture={capture}
                        snapshot={snapshot}
                        deselect={deselect}
                        focusSpot={focusSpot}
                        place={place}
                        restorePlace={restorePlace}
                        pendingRestore={pendingRestore}
                        pendingPulse={pendingPulse}
                        pulseBlocks={pulseBlocks}
                        goBlock={goBlock}
                        onOffscreen={setOffscreenChanges}
                        onHotkey={onHotkey}
                        onDirty={() => setEdited(true)}
                        marked={[
                          ...notes.flatMap((n) => n.spots.map((sp) => sp.id)),
                          ...anchored.flatMap((a) => (a.elementId === null ? [] : [a.elementId])),
                        ]}
                        mode={mode}
                        readOnly={pinnedOld}
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
                            {noteFiles.length === 0 ? null : (
                              <div className="attached in-note">
                                {noteFiles.map((a) => (
                                  <span className={a.text ? "chip text" : "chip"} key={a.hash}>
                                    {a.url !== null ? (
                                      <img src={a.url} alt="" className="thumb" />
                                    ) : (
                                      <span className="thumb kind">{a.text ? "text" : "file"}</span>
                                    )}
                                    <span className="chip-name">{a.name}</span>
                                    <button
                                      type="button"
                                      className="chip-drop"
                                      title="Remove"
                                      onClick={() => removeNoteFile(a.hash)}
                                    >
                                      ×
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="note-pop-actions">
                              {/* The half that carries this feature: a
                              screenshot of what is wrong with a paragraph is
                              marking up, which is what lucid is for. */}
                              <label className="attach small" title="Attach a file to this note">
                                +
                                <input
                                  type="file"
                                  multiple
                                  onChange={(e) => {
                                    if (e.currentTarget.files !== null)
                                      void attachToNote(e.currentTarget.files);
                                    e.currentTarget.value = "";
                                  }}
                                />
                              </label>
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

                    {/* The guidance line, under the sheet on the ground. */}
                    <div className="doc-panel">
                      <div className={`guidance ${guidance.tone}`}>{guidance.text}</div>

                      {/* Saving moved to the top bar with #171, and this is
                        what is left: the last save's outcome, which is news
                        rather than an action. A second Save down here would be
                        a second place to look for the same thing. */}
                      {saved === null ? null : <div className="note-actions">{saved}</div>}
                    </div>
                  </div>

                  {/* A confirmation, because a restore puts a new version in
                  front of the agent. It says the undo out loud: someone
                  deciding whether to restore is deciding whether it is
                  reversible, and here it is - permanently, because nothing
                  is overwritten. */}
                  {!confirmDiscardEdit ? null : (
                    <div className="confirm">
                      <span>
                        Throw away the change you have not saved? Saving keeps it as the next
                        version, and every version stays in the record, so a save is the reversible
                        one.
                      </span>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          setConfirmDiscardEdit(false);
                          setEdited(false);
                          // The change lives in the frame, so the frame has to
                          // be rebuilt from the stored bytes to be rid of it.
                          setDoc((d) => (d === null ? d : { ...d }));
                        }}
                      >
                        Discard
                      </button>
                      <button type="button" onClick={() => setConfirmDiscardEdit(false)}>
                        Cancel
                      </button>
                    </div>
                  )}

                  {confirmDiscard === null ? null : (
                    <div className="confirm">
                      <span>
                        Show v{confirmDiscard} and lose the change you have not saved? Saving
                        instead keeps it: it lands on top of v{confirmDiscard} as the next version,
                        and the agent is told what it was based on.
                      </span>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          setEdited(false);
                          setConfirmDiscard(null);
                          goToNewest();
                        }}
                      >
                        Discard and show it
                      </button>
                      <button type="button" onClick={() => setConfirmDiscard(null)}>
                        Cancel
                      </button>
                    </div>
                  )}

                  {confirmRestore === null ? null : (
                    <div className="confirm">
                      <span>
                        Make v{confirmRestore} the current version? It is copied to the end of the
                        list as v{(catalog?.latest ?? doc.version) + 1}. Nothing is deleted, and
                        going back is restoring v{catalog?.latest ?? doc.version} the same way.
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
              {/* The conversation's own 34px row, aligned with the document
              header so both columns top out together: its name, what is
              driving it, and how it stands. */}
              <div className="conv-head">
                <span className="conv-name">
                  {conversationId === "" ? "no conversation" : conversationId}
                </span>
                {driver.harness === undefined ? null : (
                  <span
                    className="conv-driver"
                    title={driver.harnessVersion === undefined ? undefined : driver.harnessVersion}
                  >
                    {driver.harness}
                    {driver.model === undefined ? "" : ` · ${driver.model}`}
                  </span>
                )}
                <span
                  className={busy ? "conv-pill busy" : "conv-pill"}
                  title={status === "" ? undefined : status}
                >
                  <span className="dot" aria-hidden="true" />
                  <span className="label">{busy ? "working" : "idle"}</span>
                </span>
              </div>
              <Thread
                pending={notes}
                onSendNotes={() => void sendNotes()}
                onDiscardNotes={() => setNotes([])}
                sending={sending}
                activity={activity}
                now={now}
                lastChange={lastChange}
                attachments={attached}
                onAttach={(files) => void attachFiles(files)}
                onRemoveAttachment={removeAttachment}
              />
            </div>
          </div>
        </FocusSpot.Provider>
      </Resolutions.Provider>
    </AssistantRuntimeProvider>
  );
};

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
