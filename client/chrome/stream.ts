/**
 * The chrome's live channel: one reconnecting WebSocket per stream.
 *
 * WebSockets, and not EventSource, for one reason. A browser allows six
 * HTTP/1.1 connections per ORIGIN, and the hub serves every session from one -
 * so with the shell's own listing stream plus a stream per open tab, the sixth
 * of them took the last socket in the pool. Every fetch after that queued
 * behind streams that never end: sending an annotation, polling state, the
 * outbox flush. It looked like the hub had stopped answering, and the hub had
 * no record of the requests at all, because they never left the browser.
 * WebSockets are not drawn from that pool.
 *
 * Reconnection lives HERE, once. EventSource retried a dropped connection but
 * not a rejected one, so each caller layered its own recovery on top of a
 * partial one - and only the session stream ever did, which left the shell's
 * listing dead for good after a hub restart. A WebSocket retries nothing by
 * itself, which makes this the only policy.
 */

/** What a caller does with the channel. `type` is the frame's event name, or
 *  "message" for the default frame - SSE's own vocabulary, unchanged. */
export interface StreamHandlers {
  readonly onFrame: (type: string, data: string) => void;
  /** A connection opened. Fires on the FIRST open too, so anything a caller
   *  wants re-read per connection can be done in one place. */
  readonly onOpen: () => void;
  /** No connection right now, and this many consecutive attempts have failed.
   *  Fires on every drop, so a caller can say "reconnecting" honestly. */
  readonly onDown: (retries: number) => void;
}

export interface StreamOptions {
  /** Ceiling on the backoff. A harness that kills streams on purpose can hand
   *  down a lower one so a test is not billed real-world patience; never a
   *  higher one than the production ceiling. */
  readonly maxBackoffMs?: number;
}

export interface LiveStream {
  /** Stop for good: no further frames, no further reconnects. */
  readonly close: () => void;
}

/** The production ceiling on reconnect backoff. */
const MAX_BACKOFF_MS = 15_000;

/** How long a connection must survive before it counts as one that WORKED,
 *  and so clears the backoff. Shorter than any real session, longer than an
 *  open-then-immediately-dropped socket. */
const STABLE_MS = 5_000;

/**
 * The server asking us to hang up and come back (see live.ts). It cannot close
 * the socket itself - doing so wedges Bun's own shutdown - so every close is
 * client-initiated, and this is how the server requests one. Reconnecting is
 * the point: the hub re-decides which server owns the session on the way back.
 */
const RECONNECT_FRAME = "reconnect";

/** Same-origin ws:// URL for a path the page was served from. */
const socketUrl = (path: string): string => {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

export const openStream = (
  path: string,
  handlers: StreamHandlers,
  options: StreamOptions = {},
): LiveStream => {
  const ceiling = Math.min(options.maxBackoffMs ?? MAX_BACKOFF_MS, MAX_BACKOFF_MS);
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let openedAt = 0;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    const ws = new WebSocket(socketUrl(path));
    socket = ws;
    ws.onopen = () => {
      openedAt = Date.now();
      handlers.onOpen();
    };
    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(e.data) as { event: string | null; data: string };
        if (frame.event === RECONNECT_FRAME) {
          // Hanging up here routes through `onclose` below, so the reconnect
          // is the same one a dropped socket gets - backoff, state, and all.
          ws.close();
          return;
        }
        handlers.onFrame(frame.event ?? "message", frame.data);
      } catch {
        /* a frame we cannot parse is not worth tearing the stream down for */
      }
    };
    // `onclose` fires for a refused connection as well as a dropped one, so it
    // is the single place reconnection is decided; `onerror` always precedes
    // it and would only double-count.
    ws.onclose = () => {
      if (socket !== ws) return; // superseded by a newer attempt
      socket = null;
      if (closed) return;
      // Only a connection that LASTED clears the backoff. Opening is not
      // enough: the hub answers the handshake for a proxied session before it
      // discovers the server behind it is unreachable, then asks us to come
      // back - and resetting on open alone would turn that into a reconnect
      // every second for as long as it kept happening.
      if (openedAt !== 0 && Date.now() - openedAt >= STABLE_MS) retries = 0;
      openedAt = 0;
      retries += 1;
      handlers.onDown(retries);
      // The first retry waits a second; a hub that stays down is asked less
      // and less often, up to the ceiling.
      const delay = Math.min(1000 * 2 ** (retries - 1), ceiling);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const ws = socket;
      socket = null;
      ws?.close();
    },
  };
};
