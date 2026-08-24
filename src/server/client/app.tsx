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
      <Thread />
    </AssistantRuntimeProvider>
  );
};

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
