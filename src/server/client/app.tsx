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
}: {
  doc: Doc;
  onSelection: (ids: readonly string[]) => void;
}): React.ReactElement => {
  const ref = React.useRef<HTMLIFrameElement | null>(null);

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
      if (m.source !== FRAME_MESSAGE_SOURCE || m.kind !== "selection") return;
      if (m.artifactId !== doc.artifactId || m.version !== doc.version) return;
      if (!Array.isArray(m.ids)) return;
      if (!m.ids.every((id) => typeof id === "string" && ELEMENT_ID.test(id))) return;

      onSelection(m.ids as string[]);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [doc.artifactId, doc.version, onSelection]);

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
        const { artifacts } = (await res.json()) as { artifacts: CatalogEntry[] };
        // One document beside the conversation in this slice. The newest
        // artifact the record holds is the one shown.
        const entry = artifacts[artifacts.length - 1];
        if (entry === undefined) return;
        const want = `${entry.artifactId}@${entry.latest}`;
        if (want === shown.current) return;
        fetching.current = true;
        try {
          const one = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(entry.artifactId)}/${entry.latest}`,
            { headers: { [TOKEN_HEADER]: token } },
          );
          if (!alive || !one.ok) return;
          const body = (await one.json()) as Doc;
          if (!alive) return;
          shown.current = want;
          setSelection([]);
          setDoc(body);
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
  }, [token, dead, conversationId]);

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
              <span className="doc-version">v{doc.version}</span>
            </div>
            <DocumentFrame doc={doc} onSelection={setSelection} />
            <div className="doc-foot">
              {selection.length === 0
                ? "Click something in the document to select it. Hold command to select more."
                : `${selection.length} selected`}
            </div>
          </div>
        )}
      </div>
    </AssistantRuntimeProvider>
  );
};

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
