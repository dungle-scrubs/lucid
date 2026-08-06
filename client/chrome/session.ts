import type { LogEvent } from "../../src/core/events.ts";
import {
  DEFAULT_FRAME,
  dispatchFrame,
  type FrameHandlers,
  type SessionFrame,
} from "../../src/protocol/frames.ts";
import { lifecycleStatusOf, verdictOf, type SelectionResponse } from "../../src/protocol/wire.ts";
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
  /** Decode one frame off the live channel and apply it, exactly as the open
   *  stream does. Exported like the hub's `onHubFrame` and for the same reason:
   *  this is the seam where a session's wire becomes its state, and what it
   *  makes of a frame is worth pinning without a socket. */
  readonly onFrame: (event: string, data: string) => void;
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

  const set = store.setState;

  /**
   * The sticky model/effort AND the vocabulary it is picked in. This route is
   * the ONE source of both, even though the value also rides `/__lucid/state`:
   * the vocabulary is only here (a server with no harness recipe answers
   * without `info`, which is what leaves the pickers off), so folding the
   * value in from a second place would only add a race in which a bootstrap
   * fired before a pick lands after it.
   *
   * One applier for all three arrivals - the read below, the broadcast frame,
   * and the answer to a write - so the response shape is mapped into state
   * once. The write used to map it a second time, in the picker component.
   */
  const applySelection = (r: SelectionResponse): void => {
    set({
      selection: r.selection,
      selectionHarnesses: r.harnesses ?? [],
      selectionInfo: r.info ?? null,
    });
  };

  const actions = createActions({
    store,
    transport,
    surface,
    pastes,
    storage,
    notify,
    applySelection,
  });

  const onLogEvent = (ev: LogEvent): void => {
    // Where the session IS, through the one table that says what a lifecycle
    // event means (src/protocol/wire.ts). The chrome used to keep a list of
    // its own here, and the entry it lacked was `session_resumed`: a session
    // healed by this very tab reconnecting stayed "suspended" on screen until
    // a reload, with the composer, the working line and the revise notice
    // switched off behind it.
    const lifecycle = lifecycleStatusOf(ev.t);
    if (lifecycle !== null) {
      // Tell the surface first: a bootstrap already in flight carries the
      // lifecycle the server held BEFORE this frame, and must not put it back.
      surface.noteLifecycle();
      set({ status: lifecycle });
      return;
    }
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
      // A verdict is state AND an entry in the record: the boolean drives the
      // header and the approve guard, the appended event is what lets the
      // transcript show where it happened. Appended by seq so a frame that
      // arrives twice cannot double-enter the record.
      case "review_resolved":
      case "review_reopened": {
        set((s) => ({
          reviewResolved: ev.t === "review_resolved",
          verdicts: s.verdicts.some((v) => v.seq === ev.seq)
            ? s.verdicts
            : [...s.verdicts, verdictOf(ev)],
        }));
        break;
      }
      // A clear rewrites what the record IS, so the fold is the only honest
      // source: re-read it rather than patching state here. The bootstrap also
      // brings back the boundary entry with its hidden count, which this
      // handler has no way to compute.
      case "record_cleared":
        void surface.bootstrap();
        break;
      default:
        break;
    }
  };

  /** Read once per (re)connect: a registry edited while this tab was open would
   *  otherwise keep offering the vocabulary it started with. A server that
   *  predates the route answers 404 and the pickers stay off. */
  const loadSelection = async (): Promise<void> => {
    const body = await transport.get<SelectionResponse>("/__lucid/selection");
    if (body) applySelection(body);
  };

  /**
   * How a frame off the live channel reaches this session's state. The default
   * frame carries a log event; the rest are the synthetic ones the server has
   * no log event for.
   *
   * One handler per frame the server can send, keyed by the frame union's own
   * names (src/protocol/frames.ts) - so a frame renamed or added on the server
   * stops this file compiling instead of being dropped in silence, and each
   * payload arrives typed rather than re-declared here.
   */
  const frameHandlers: FrameHandlers<SessionFrame> = {
    [DEFAULT_FRAME]: (ev) => onLogEvent(ev),
    listeners: ({ agents }) => {
      // An agent arriving flips the selection pickers to a readout of what
      // THAT session runs, and its stamp only rides the folded state.
      // Without this re-read the row would report the PREVIOUS attendant's
      // model until some unrelated content event happened to land.
      const arriving = agents > 0 && store.getState().agentsListening === 0;
      set({ agentsListening: agents });
      if (arriving) void surface.bootstrap();
    },
    // Presence: the harness conversation opened or closed in a terminal. No
    // log event accompanies that, so it arrives as its own frame - and it
    // changes the panel's whole mode, so it must not wait for one.
    presence: (attendantPresence) => set({ attendantPresence }),
    warning: (w) => notify.pushWarning(w.code, w.message),
    context: (contextUsage) => set({ contextUsage }),
    // Another window (or another tab on this session) changed the pick:
    // every viewer of the artifact shows the same sticky selection.
    selection: (r) => applySelection(r),
  };

  const onFrame = (type: string, data: string): void => {
    try {
      dispatchFrame(frameHandlers, type, data);
    } catch {
      /* a frame we cannot parse is not worth tearing the stream down for */
    }
  };

  let stream: LiveStream | null = null;

  /**
   * Is this session still on the server, or is the tab pointing at a record
   * that is gone? Only a definite 404 answers yes-it-is-gone: a network error
   * or a 5xx means the server is unreachable or unwell, which is exactly what
   * retrying is for.
   */
  const checkGone = async (): Promise<void> => {
    // null is "nothing answered" - unreachable, not gone.
    if ((await transport.probe("/__lucid/identity")) !== 404) return;
    set({ gone: true, live: false });
    disconnect();
  };

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
        //
        // But a drop that keeps happening deserves ONE question: is there
        // still a session here? A WebSocket handshake refused with 404 is
        // indistinguishable from a refused connection in the browser - the
        // status never reaches JS - so the socket alone can retry a session
        // that no longer exists until the tab is closed. Two failures in,
        // ask a route that CAN answer.
        onDown: (retries) => {
          set({ live: false, streamRetries: retries });
          if (retries === 2) void checkGone();
        },
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
    onFrame,
    connect,
    disconnect,
    connected: () => stream !== null,
  };
};
