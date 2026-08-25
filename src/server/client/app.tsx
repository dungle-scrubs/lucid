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
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  type Annotation,
  type AnnotationSpot,
  clampSnippet,
  encodeAnnotationBatch,
} from "../../protocol/annotations.js";
import {
  type Confidence,
  resolveSpot,
  type SpotSelectors,
  selectorsFor,
  sha256Hex,
} from "./anchor.js";
import { ELEMENT_ID, FRAME_MESSAGE_SOURCE, instrumentArtifact } from "./instrument.js";

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
}

interface Driver {
  readonly harness?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly harnessVersion?: string;
}

interface Msg {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly text: string;
  /** Set for a tool call, so it renders as one quiet line rather than as an
   * agent message. Six tool calls shown as six messages bury the one
   * message the person was waiting for. */
  readonly tool?: boolean;
}

/** `/c/<id>` — the conversation is named by the URL, never by the bundle. */
const conversationIdFromPath = (): string => {
  const m = window.location.pathname.match(/^\/c\/([^/]+)\/?$/);
  return m?.[1] === undefined ? "" : decodeURIComponent(m[1]);
};

const linesToMessages = (lines: readonly Line[]): Msg[] =>
  lines
    .filter((l) => l.text.trim() !== "")
    .map((l, i) => ({
      id: l.seq === undefined ? `l-${i}` : `s-${l.seq}-${i}`,
      role: l.kind === "agent" ? ("assistant" as const) : ("user" as const),
      text: l.text,
      ...(l.event === "tool" ? { tool: true } : {}),
    }));

/** Who said it has to survive into the DOM: a transcript where the person
 * and the agent look identical is not a transcript. The role is not on the
 * message element, so it is read through `If` and written as a class. */
const Message = (): React.ReactElement => {
  // A tool call is the agent working, not the agent talking. Rendered as a
  // message it looks like something to read, and six of them in a row bury
  // the one thing that was.
  const original = useMessage((m) => getExternalStoreMessage<Msg>(m));
  const one = Array.isArray(original) ? original[0] : original;
  const isTool = one?.tool === true;

  if (isTool) {
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

  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.If user>
        <div className="msg user">
          <span className="who">you</span>
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
const Thread = (): React.ReactElement => (
  <ThreadPrimitive.Root className="thread-root">
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
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input autoFocus placeholder="Send to the conversation…" rows={1} />
      <ComposerPrimitive.Send asChild>
        <button type="submit">Send</button>
      </ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  </ThreadPrimitive.Root>
);

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
const DocumentFrame = ({
  doc,
  onSelection,
  capture,
  snapshot,
  onDirty,
  marked,
  mode,
}: {
  doc: Doc;
  onSelection: (ids: readonly string[]) => void;
  /** Handed the frame's answer to a capture request. */
  capture: React.MutableRefObject<((ids: readonly string[]) => Promise<AnnotationSpot[]>) | null>;
  /** Handed the frame's answer to a snapshot request: the document as it now
   * reads, with lucid's instrumentation taken back out, and the values of
   * the controls the agent authored. */
  snapshot: React.MutableRefObject<
    (() => Promise<{ html: string; values: Record<string, string> } | null>) | null
  >;
  /** The frame says when a person has changed something in it. */
  onDirty: () => void;
  /** Spots that already carry a note, marked in the document while the
   * batch is being composed. */
  marked: readonly string[];
  mode: "use" | "markup";
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

      onSelection(m.ids as string[]);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [doc.artifactId, doc.version, onSelection, onDirty]);

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
    return () => {
      capture.current = null;
      snapshot.current = null;
    };
  }, [capture, snapshot]);

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
        { source: FRAME_MESSAGE_SOURCE, kind: "mode", mode },
        "*",
      );
    send();
    const id = window.setInterval(send, 1000);
    return () => window.clearInterval(id);
  }, [mode]);

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

const App = (): React.ReactElement => {
  const conversationId = React.useMemo(conversationIdFromPath, []);
  const [token, setToken] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [status, setStatus] = React.useState<string>("");
  /** What is driving: harness, model when known, and profile. */
  const [driver, setDriver] = React.useState<Driver>({});
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
  const [pinned, setPinned] = React.useState<number | null>(null);
  /** A version that arrived while there was work pending. It waits here and
   * is announced rather than swapped in underneath. */
  const [waiting, setWaiting] = React.useState<number | null>(null);
  /** Notes written but not yet sent. They accumulate: a batch is composed
   * over several selections and leaves as one act. */
  /** Unsent notes, kept per version. A note addresses an element in the
   * render it was made against, so it belongs to that version — and looking
   * at another version and coming back must not have lost it. */
  const [notesByVersion, setNotesByVersion] = React.useState<Record<string, readonly Annotation[]>>(
    {},
  );
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
    (next: readonly Annotation[]) => setNotesByVersion((prev) => ({ ...prev, [docKey]: next })),
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
        };
        if (!alive) return;
        setMessages(linesToMessages(data.lines));
        setStatus(data.status);
        setDriver(data.driver ?? {});
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
        // One document beside the conversation in this slice. The newest
        // artifact the record holds is the one shown.
        const entry = artifacts[artifacts.length - 1];
        if (entry === undefined) return;
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
  }, [token, dead, conversationId, pinned]);

  const addNote = React.useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || selection.length === 0 || capture.current === null) return;
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
    setNotes([...notes, { note: text, spots: withSelectors }]);
    setDraft("");
    setSelection([]);
    setRefusal(null);
  }, [draft, selection, notes, setNotes, doc]);

  const sendNotes = React.useCallback(async (): Promise<void> => {
    if (notes.length === 0 || doc === null || token === null || dead) return;
    // One request. Every note goes together, as one input with one id, one
    // disposition, and one turn.
    const body = encodeAnnotationBatch({
      artifactId: doc.artifactId,
      version: doc.version,
      notes,
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
  }, [notes, doc, token, dead, conversationId, setNotes]);

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
        text: `[saved ${catalog?.artifactId} v${v}]`,
      }));
    return saves.length === 0 ? messages : [...messages, ...saves];
  }, [messages, catalog]);

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
  const guidance = ((): { text: string; tone: "idle" | "ready" | "warn" } => {
    if (doc === null) return { text: "No document in this conversation yet.", tone: "idle" };
    if (refusal !== null) return { text: refusal, tone: "warn" };
    if (edited) return { text: "You changed the document. Save to keep it.", tone: "ready" };
    if (selection.length > 0)
      return {
        text: `${selection.length} selected. Write what you want to say about ${selection.length === 1 ? "it" : "them"}, then Add note.`,
        tone: "ready",
      };
    if (notes.length > 0)
      return {
        text: `${notes.length} note${notes.length === 1 ? "" : "s"} ready. Send when you are done, or select more.`,
        tone: "ready",
      };
    if (mode === "markup")
      return {
        text: "Marking up: click a part of the document to select it, ⌘-click to add more. Controls do not respond while you are marking up.",
        tone: "idle",
      };
    return {
      text: "Using the document: tick boxes, fill fields, and click text to edit it. Switch to Mark up to write notes about it.",
      tone: "idle",
    };
  })();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
          {doc === null ? (
            <div className="empty doc-empty">
              Nothing to mark up yet. Ask the agent for a document.
            </div>
          ) : (
            <>
              <div className="doc-head">
                <span className="doc-id">{doc.artifactId}</span>
                {catalog === null || catalog.versions.length < 2 ? (
                  <span className="doc-version">v{doc.version}</span>
                ) : (
                  <span className="doc-versions">
                    {catalog.versions.map((v) => (
                      <button
                        type="button"
                        key={v}
                        className={v === doc.version ? "v current" : "v"}
                        title={
                          catalog.authors?.[v] === "human"
                            ? `v${v} — saved by you`
                            : `v${v} — written by the agent`
                        }
                        onClick={() => setPinned(v)}
                      >
                        v{v}
                        {catalog.authors?.[v] === "human" ? " ✎" : ""}
                      </button>
                    ))}
                  </span>
                )}
                {pinned === null ? null : (
                  <button type="button" className="v latest" onClick={() => setPinned(null)}>
                    follow newest
                  </button>
                )}
                <span className="modes">
                  <button
                    type="button"
                    className={mode === "use" ? "m current" : "m"}
                    onClick={() => setMode("use")}
                    title="Tick boxes, fill fields, and edit text"
                  >
                    Use
                  </button>
                  <button
                    type="button"
                    className={mode === "markup" ? "m current" : "m"}
                    onClick={() => setMode("markup")}
                    title="Click parts of the document to write notes about them"
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

              <DocumentFrame
                doc={doc}
                onSelection={setSelection}
                capture={capture}
                snapshot={snapshot}
                onDirty={() => setEdited(true)}
                marked={[
                  ...notes.flatMap((n) => n.spots.map((sp) => sp.id)),
                  ...anchored.flatMap((a) => (a.elementId === null ? [] : [a.elementId])),
                ]}
                mode={mode}
              />

              {/* Everything below here has a fixed height and never scrolls
                  out of view. The actions were reachable only by scrolling a
                  panel that grew with the notes in it. */}
              <div className="doc-panel">
                <div className={`guidance ${guidance.tone}`}>{guidance.text}</div>

                {anchored.length === 0 && notes.length === 0 ? null : (
                  <ul className="notes">
                    {anchored.map((a) => (
                      <li
                        key={`sent:${a.fromVersion}:${a.snippet}:${a.note}`}
                        className={a.elementId === null ? "sent orphan" : "sent"}
                      >
                        <span className="note-text">{a.note}</span>
                        <span className="note-spots">
                          {a.elementId === null ? (
                            <>
                              <strong>lost its target</strong>
                              {" — written against v"}
                              {a.fromVersion} on “{a.snippet.slice(0, 44)}”
                              {a.why === "unverified-source"
                                ? " (that version could not be verified)"
                                : ""}
                            </>
                          ) : (
                            <>
                              {a.how === null
                                ? "sent · on this version"
                                : a.how === "exact"
                                  ? "sent · found again, exactly"
                                  : a.how === "approximate"
                                    ? "sent · found again, reworded"
                                    : a.how === "position"
                                      ? "sent · found by position, may be the wrong element"
                                      : "sent · found by path, may be the wrong element"}
                              {a.fromVersion === doc.version ? "" : ` (from v${a.fromVersion})`}
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                    {notes.map((n) => (
                      <li key={`draft:${n.spots.map((sp) => sp.id).join(",")}:${n.note}`}>
                        <span className="note-text">{n.note}</span>
                        <span className="note-spots">
                          not sent ·{" "}
                          {n.spots.map((sp) => `“${sp.snippet.slice(0, 34)}”`).join(", ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="note-compose">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void addNote();
                      }
                    }}
                    placeholder={
                      selection.length === 0
                        ? "Select something in the document first"
                        : `What about ${selection.length === 1 ? "this" : `these ${selection.length}`}? (⌘⏎ to add)`
                    }
                    disabled={selection.length === 0}
                    rows={2}
                  />
                  <div className="note-actions">
                    <button
                      type="button"
                      onClick={() => void addNote()}
                      disabled={selection.length === 0 || draft.trim() === ""}
                    >
                      Add note
                    </button>
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={!edited || saving}
                      title="Double-click text in the document to edit it; controls work as they are"
                    >
                      {saving ? "Saving…" : edited ? "Save changes" : "Saved"}
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void sendNotes()}
                      disabled={notes.length === 0}
                    >
                      {notes.length === 0
                        ? "Send notes"
                        : `Send ${notes.length} note${notes.length === 1 ? "" : "s"}`}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="pane conversation">
          <Thread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
};

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
