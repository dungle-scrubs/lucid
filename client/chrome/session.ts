import type { LogEvent } from "../../src/core/events.ts";
import { hubFetch } from "./request.ts";
import type { ContextUsage, SelectionResponse } from "../../src/protocol/wire.ts";
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
import { openStream, type LiveStream } from "./stream.ts";
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
  /** Open this session's live stream (idempotent). Called when the handle
   *  enters the shell roster - the stream belongs to the handle's lifetime,
   *  NOT to whether its view is on screen, so a background tab keeps folding
   *  events and draining its outbox. */
  readonly connect: () => void;
  /** Close the stream (eviction/teardown). State stays; reconnecting
   *  re-bootstraps. */
  readonly disconnect: () => void;
  /** Whether the live stream is currently open (the cap counts these). */
  readonly connected: () => boolean;
}

export const createSession = (config: SessionConfig): SessionHandle => {
  const transport = createTransport(config.base);
  const storage = createSessionStorage(config.session, transport.assetUrl);
  const store = createSessionStore(config, storage);
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
      // A turn ending changes what the panel says (the window closes, the
      // outcome appears), and the fold is where that is derived - so this must
      // re-read like any other content event. Without it the frame arrives,
      // falls through to `default`, and the viewer keeps painting a turn that
      // has stopped.
      case "agent_turn_ended":
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

  /**
   * The sticky model/effort AND the vocabulary it is picked in. This route is
   * the ONE source of both, even though the value also rides `/__lucid/state`:
   * the vocabulary is only here (a server with no harness recipe answers
   * without `info`, which is what leaves the pickers off), so folding the
   * value in from a second place would only add a race in which a bootstrap
   * fired before a pick lands after it.
   */
  const applySelection = (r: SelectionResponse): void => {
    set({ selection: r.selection, selectionInfo: r.info ?? null });
  };

  /** Read once per (re)connect: a registry edited while this tab was open would
   *  otherwise keep offering the vocabulary it started with. A server that
   *  predates the route answers 404 and the pickers stay off. */
  const loadSelection = async (): Promise<void> => {
    const res = await hubFetch(`${config.base}/__lucid/selection`).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json().catch(() => null)) as SelectionResponse | null;
    if (body) applySelection(body);
  };

  /** How a frame off the live channel reaches this session's state. Keyed by
   *  the event name the server broadcasts (see live.ts); "message" is the
   *  default frame, which carries a log event. */
  const onFrame = (type: string, data: string): void => {
    try {
      switch (type) {
        case "message":
          onLogEvent(JSON.parse(data) as LogEvent);
          break;
        case "listeners": {
          const d = JSON.parse(data) as { agents: number };
          // An agent arriving flips the selection pickers to a readout of what
          // THAT session runs, and its stamp only rides the folded state.
          // Without this re-read the row would report the PREVIOUS attendant's
          // model until some unrelated content event happened to land.
          const arriving = d.agents > 0 && store.getState().agentsListening === 0;
          set({ agentsListening: d.agents });
          if (arriving) void surface.bootstrap();
          break;
        }
        // Presence: the harness conversation opened or closed in a terminal. No
        // log event accompanies that, so it arrives as its own frame - and it
        // changes the panel's whole mode, so it must not wait for one.
        case "presence":
          set({
            attendantPresence: JSON.parse(data) as {
              interactive: boolean;
              status?: string;
              cwd?: string;
            } | null,
          });
          break;
        case "warning": {
          const w = JSON.parse(data) as { code: string; message: string };
          notify.pushWarning(w.code, w.message);
          break;
        }
        case "context":
          set({ contextUsage: JSON.parse(data) as ContextUsage });
          break;
        // Another window (or another tab on this session) changed the pick:
        // every viewer of the artifact shows the same sticky selection.
        case "selection":
          applySelection(JSON.parse(data) as SelectionResponse);
          break;
        default:
          break;
      }
    } catch {
      /* a frame we cannot parse is not worth tearing the stream down for */
    }
  };

  let stream: LiveStream | null = null;

  const connect = (): void => {
    if (stream !== null) return;
    stream = openStream(
      `${config.base}/__lucid/events`,
      {
        onFrame,
        // Re-fetch on every (re)open: synthetic frames (listeners, context) go
        // only to connected clients and are never replayed, so anything
        // reported while the stream was down would otherwise stay stale until
        // the next report. bootstrap() is seq-guarded, so the extra fetch at
        // first open is harmless.
        onOpen: () => {
          set({ live: true, streamRetries: 0 });
          void surface.bootstrap();
          void loadSelection();
          // A live stream means the server is answering again, which is the
          // only thing an undelivered message was waiting on. Fires on the
          // first open too, so a message stranded by a closed tab leaves on the
          // next load without the human having to notice it.
          void actions.flushOutbox();
        },
        // A drop is a state to show, not a warning to accumulate: one warning
        // per failed attempt spammed the panel and told the human to reload,
        // which was never true.
        onDown: (retries) => set({ live: false, streamRetries: retries }),
      },
      ...(config.sseMaxBackoffMs === undefined
        ? []
        : ([{ maxBackoffMs: config.sseMaxBackoffMs }] as const)),
    );
    // First paint should not wait for the stream to open: fetch the folded
    // state immediately (seq-guarded, so the onopen re-fetch is harmless).
    void surface.bootstrap();
    void loadSelection();
  };

  const disconnect = (): void => {
    stream?.close();
    stream = null;
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
    connected: () => stream !== null,
  };
};
