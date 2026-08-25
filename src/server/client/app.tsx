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
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  type Annotation,
  type AnnotationSpot,
  clampSnippet,
  encodeAnnotationBatch,
} from "../../protocol/annotations.js";
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
}

interface Msg {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly text: string;
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
    }));

/** Who said it has to survive into the DOM: a transcript where the person
 * and the agent look identical is not a transcript. The role is not on the
 * message element, so it is read through `If` and written as a class. */
const Message = (): React.ReactElement => (
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

const Thread = (): React.ReactElement => (
  <ThreadPrimitive.Root className="thread-root">
    <ThreadPrimitive.Viewport className="thread">
      <ThreadPrimitive.Empty>
        <div className="empty">Nothing in this conversation yet.</div>
      </ThreadPrimitive.Empty>
      <ThreadPrimitive.Messages components={{ Message }} />
    </ThreadPrimitive.Viewport>
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
  marked,
}: {
  doc: Doc;
  onSelection: (ids: readonly string[]) => void;
  /** Handed the frame's answer to a capture request. */
  capture: React.MutableRefObject<((ids: readonly string[]) => Promise<AnnotationSpot[]>) | null>;
  /** Spots that already carry a note, marked in the document while the
   * batch is being composed. */
  marked: readonly string[];
}): React.ReactElement => {
  const ref = React.useRef<HTMLIFrameElement | null>(null);
  const pending = React.useRef(new Map<string, (spots: AnnotationSpot[]) => void>());
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
      if (m.kind !== "selection" && m.kind !== "captured") return;
      if (m.artifactId !== doc.artifactId || m.version !== doc.version) return;
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
  }, [doc.artifactId, doc.version, onSelection]);

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
    return () => {
      capture.current = null;
    };
  }, [capture]);

  React.useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      { source: FRAME_MESSAGE_SOURCE, kind: "mark", ids: [...marked] },
      "*",
    );
  }, [marked]);

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
  const [marks, setMarks] = React.useState<Record<string, string[]>>({});
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

  const docKey = doc === null ? "" : `${doc.artifactId}@${doc.version}`;
  const notes = React.useMemo(() => notesByVersion[docKey] ?? [], [notesByVersion, docKey]);
  /** Work pending: something selected, something typed, or notes not sent.
   * lucid never changes version under a person who has work pending — that
   * is what makes replacing the whole frame safe, and why no attempt is made
   * to patch the document in place. */
  const pending = selection.length > 0 || draft.trim() !== "" || notes.length > 0;
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
        };
        if (!alive) return;
        setMessages(linesToMessages(data.lines));
        setStatus(data.status);
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
          marks?: Record<string, string[]>;
        };
        const artifacts = body.artifacts;
        // One document beside the conversation in this slice. The newest
        // artifact the record holds is the one shown.
        const entry = artifacts[artifacts.length - 1];
        if (entry === undefined) return;
        setCatalog(entry);
        setMarks(body.marks ?? {});

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
    setNotes([...notes, { note: text, spots }]);
    setDraft("");
    setSelection([]);
    setRefusal(null);
  }, [draft, selection, notes, setNotes]);

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

  const runtime = useExternalStoreRuntime<Msg>({
    messages,
    setMessages: (next) => setMessages([...next]),
    onNew,
    convertMessage: (m: Msg) => ({
      id: m.id,
      role: m.role,
      content: [{ type: "text" as const, text: m.text }],
    }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <header className="head">
        <span className="id">{conversationId === "" ? "no conversation" : conversationId}</span>
        <span className="status">{status}</span>
      </header>
      {problem === null ? null : <div className="notice">{problem}</div>}
      <div className={doc === null ? "panes" : "panes with-doc"}>
        <div className="pane conversation">
          <Thread />
        </div>
        {doc === null ? null : (
          <div className="pane document">
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
                      onClick={() => setPinned(v)}
                    >
                      v{v}
                    </button>
                  ))}
                </span>
              )}
              {pinned === null ? null : (
                <button type="button" className="v latest" onClick={() => setPinned(null)}>
                  follow newest
                </button>
              )}
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
              marked={[
                ...notes.flatMap((n) => n.spots.map((sp) => sp.id)),
                // Notes already sent are marked too, on the version they
                // were made against and nowhere else.
                ...(marks[docKey] ?? []),
              ]}
            />
            <div className="doc-foot">
              {notes.length === 0 ? null : (
                <ul className="notes">
                  {notes.map((n) => (
                    <li key={`${n.spots.map((sp) => sp.id).join(",")}:${n.note}`}>
                      <span className="note-text">{n.note}</span>
                      <span className="note-spots">
                        {n.spots
                          .map((sp) => `"${sp.snippet.slice(0, 40)}" (${sp.author})`)
                          .join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {refusal === null ? null : <div className="notice">Not sent: {refusal}</div>}
              <div className="note-compose">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={
                    selection.length === 0
                      ? "Select something in the document to write about it"
                      : `Write a note about ${selection.length} selected`
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
          </div>
        )}
      </div>
    </AssistantRuntimeProvider>
  );
};

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
