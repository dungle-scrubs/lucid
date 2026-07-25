import type { LogEvent } from "../../src/core/events.ts";
import type { ContextUsage } from "../../src/protocol/wire.ts";
import { createActions, type SessionActions } from "./actions.ts";
import { createPastes, type Pastes } from "./pastes.ts";
import {
  createNotify,
  createSessionStorage,
  createSessionStore,
  type Notify,
  type SessionConfig,
  type SessionStore,
} from "./store.ts";
import { createSurface, type Surface } from "./surface.ts";
import { createTransport, type Transport } from "./transport.ts";

/**
 * One session, whole: its store, its transport, its surface sync, its
 * mutations, and its live stream. The shell holds one handle per open session
 * and renders whichever is active; a handle keeps working (stream, outbox,
 * folded state) while it is not the one on screen.
 */
export interface SessionHandle {
  /** Canonical artifact path = the session id. */
  readonly key: string;
  readonly config: SessionConfig;
  readonly store: SessionStore;
  readonly transport: Transport;
  readonly surface: Surface;
  readonly actions: SessionActions;
  readonly pastes: Pastes;
  readonly notify: Notify;
  /** Open this session's SSE stream (idempotent). Called when the handle
   *  enters the shell roster - the stream belongs to the handle's lifetime,
   *  NOT to whether its view is on screen, so a background tab keeps folding
   *  events and draining its outbox. */
  readonly connect: () => void;
  /** Close the stream (eviction/teardown). State stays; reconnecting
   *  re-bootstraps. */
  readonly disconnect: () => void;
  /** Whether the SSE stream is currently open (the cap counts these). */
  readonly connected: () => boolean;
}

export const createSession = (config: SessionConfig): SessionHandle => {
  const storage = createSessionStorage(config.session);
  const store = createSessionStore(config, storage);
  const transport = createTransport(config.base);
  const notify = createNotify(store);
  const surface = createSurface(store, transport);
  const pastes = createPastes();
  const actions = createActions({ store, transport, surface, pastes, storage, notify });

  const set = store.setState;

  const onLogEvent = (ev: LogEvent): void => {
    switch (ev.t) {
      // Every content event re-reads the folded state rather than patching it
      // locally. The log is the source of truth and the fold does real work
      // (anchor carry-forward, orphaning, image paths); a local append would be
      // a second, worse copy of it - and could be silently dropped by a
      // bootstrap that started before the append landed.
      case "annotation":
      case "revert":
      case "question":
      case "question_answered":
      case "prompt":
      case "agent_reply":
      case "agent_ack":
        void surface.bootstrap();
        break;
      case "version":
        void surface.onNewVersion(ev.version);
        break;
      case "review_resolved":
        set({ reviewResolved: true });
        break;
      case "review_reopened":
        set({ reviewResolved: false });
        break;
      case "session_ended":
        set({ status: "ended" });
        break;
      case "session_suspended":
        set({ status: "suspended" });
        break;
      default:
        break;
    }
  };

  let source: EventSource | null = null;

  const connect = (): void => {
    if (source !== null) return;
    const es = new EventSource(`${config.base}/__lucid/events`);
    source = es;
    es.onmessage = (e) => {
      try {
        onLogEvent(JSON.parse(e.data) as LogEvent);
      } catch {
        /* a frame we cannot parse is not worth tearing the stream down for */
      }
    };
    es.addEventListener("listeners", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { agents: number };
        set({ agentsListening: d.agents });
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("warning", (e) => {
      try {
        const w = JSON.parse((e as MessageEvent).data) as { code: string; message: string };
        notify.pushWarning(w.code, w.message);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("context", (e) => {
      try {
        set({ contextUsage: JSON.parse((e as MessageEvent).data) as ContextUsage });
      } catch {
        /* ignore */
      }
    });
    // EventSource retries on its own, so a drop is a state to show, not a
    // warning to accumulate: warning per failed attempt spammed the panel and
    // told the human to reload, which was never true.
    // Re-fetch on every (re)open: synthetic presence frames (listeners,
    // context) are broadcast only to connected clients and never replayed, so
    // anything reported while the stream was down would otherwise stay stale
    // until the next report. bootstrap() is seq-guarded, so the extra fetch at
    // first open is harmless.
    es.onopen = () => {
      set({ live: true });
      void surface.bootstrap();
      // A live stream means the server is answering again, which is the only
      // thing an undelivered message was waiting on. Fires on the first open
      // too, so a message stranded by a closed tab leaves on the next load
      // without the human having to notice it.
      void actions.flushOutbox();
    };
    es.onerror = () => set({ live: false });
    // First paint should not wait for the stream to open: fetch the folded
    // state immediately (seq-guarded, so the onopen re-fetch is harmless).
    void surface.bootstrap();
  };

  const disconnect = (): void => {
    source?.close();
    source = null;
    // Not an outage, but the truth: nothing live is flowing to this session
    // until it reconnects, and its indicator should say so if rendered.
    set({ live: false });
  };

  return {
    key: config.session,
    config,
    store,
    transport,
    surface,
    actions,
    pastes,
    notify,
    connect,
    disconnect,
    connected: () => source !== null,
  };
};
