/**
 * The live-channel seam: one subscriber set, two wires.
 *
 * A session's event stream and the hub's listing stream each fan one frame out
 * to every window watching. Both were SSE-only, and that put a hard ceiling on
 * the shell nobody had counted: a browser allows six HTTP/1.1 connections per
 * ORIGIN, and the hub serves every session from one. Each open tab held a
 * stream that never ends, so the sixth of them - five session tabs plus the
 * hub's own listing - took the last socket, and every fetch afterwards queued
 * behind streams that would never free one. Sending an annotation failed with
 * no server-side trace at all, because the request never left the browser.
 *
 * WebSockets are exempt from that pool (a browser allows hundreds per host),
 * so the browser now upgrades. SSE stays exactly as it was for `lucid wait`'s
 * agent-side subscriber, which reaches the same route from a process that has
 * no such limit and no reason to change.
 *
 * Both wires carry the SAME frame vocabulary - a named event and a JSON string,
 * SSE's own - so a broadcaster writes one frame and neither wire knows the
 * other exists.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";

/**
 * One watcher of a channel, whatever it is wired over. `send` may THROW when
 * the peer is gone (an SSE controller does); every broadcaster catches that
 * and drops the subscriber, which is how a closed stream leaves the set.
 *
 * `close` means "this channel is finished" - NOT "close the socket". On SSE it
 * ends the response body, which is the same thing. On a WebSocket it asks the
 * client to hang up and come back, because the server closing one itself is
 * not safe here; see `RECONNECT_FRAME`.
 */
export interface Subscriber {
  readonly send: (event: string | null, data: string) => void;
  readonly close: () => void;
}

/**
 * The frame that asks a window to drop this connection and reconnect.
 *
 * It exists because of a Bun bug (reproduced on 1.3.14): once the SERVER has
 * closed a WebSocket - `ws.close()` or `ws.terminate()`, before or after the
 * client's own close, and even after the `close` handler has fired on both
 * ends - `server.stop()` never resolves. A hub that closed one socket could
 * therefore never shut down.
 *
 * So the server never closes a live socket. It says "come back" and the CLIENT
 * hangs up, which is the one direction that is safe; the client's reconnect
 * loop (stream.ts) then applies its usual backoff. Teardown needs nothing
 * beyond that: `server.stop(true)` closes the transport, the client sees the
 * drop, and it retries until the hub is back.
 */
export const RECONNECT_FRAME = "reconnect";

const encoder = new TextEncoder();

/** SSE: the wire format is the frame. A null event is SSE's default `message`. */
export const sseSubscriber = (
  controller: ReadableStreamDefaultController<Uint8Array>,
): Subscriber => ({
  send: (event, data) =>
    controller.enqueue(
      encoder.encode(event === null ? `data: ${data}\n\n` : `event: ${event}\ndata: ${data}\n\n`),
    ),
  close: () => controller.close(),
});

/**
 * WebSocket: one JSON envelope per frame, naming the event SSE would have put
 * in its `event:` line. `data` stays a STRING rather than being inlined as
 * JSON, so every existing handler keeps parsing exactly what it parsed before.
 */
export const socketSubscriber = (ws: { readonly send: (data: string) => number }): Subscriber => {
  // A socket that is GONE reports it in the return value rather than by
  // throwing: measured on Bun 1.3.14, `send` answers the byte count while
  // open, 0 once the peer has left, and -1 for backpressure - which is a slow
  // reader, NOT a departed one, and must never be mistaken for it. Throwing on
  // 0 is what lets a broadcaster drop the subscriber, the same signal the SSE
  // wire gives by throwing from `enqueue`. Without it a dead socket would sit
  // in the set until Bun's `close` callback arrived, holding the session's
  // idle clock open and, for an agent, its presence count with it.
  const push = (frame: { event: string | null; data: string }): void => {
    if (ws.send(JSON.stringify(frame)) === 0) throw new Error("socket is gone");
  };
  return {
    send: (event, data) => push({ event, data }),
    // Deliberately NOT ws.close() - see RECONNECT_FRAME.
    close: () => push({ event: RECONNECT_FRAME, data: "" }),
  };
};

/**
 * A pending upgrade, carrying the join it should run once the socket opens.
 *
 * Bun decides the upgrade in `fetch` but hands the socket over in `open`, so
 * the route cannot subscribe at the moment it makes the decision. This object
 * rides across that gap as the socket's `data`, and holds the release so
 * `close` can unsubscribe without the handler knowing which channel it was.
 */
export class LiveSocket {
  private release: (() => void) | null = null;

  constructor(private readonly join: (sub: Subscriber) => () => void) {}

  opened(ws: ServerWebSocket<LiveSocket>): void {
    this.release = this.join(socketSubscriber(ws));
  }

  closed(): void {
    this.release?.();
    this.release = null;
  }
}

/**
 * The one WebSocket handler both servers install. Channel-agnostic on purpose:
 * everything specific to a session or to the hub was decided at upgrade time
 * and closed over by the `LiveSocket`.
 *
 * `sendPings` is what keeps a quiet review alive - a session with nothing
 * happening sends no frames for minutes, and an idle timeout would close the
 * socket under a human who is simply reading.
 */
export const liveWebSocket: WebSocketHandler<LiveSocket> = {
  open: (ws) => ws.data.opened(ws),
  close: (ws) => ws.data.closed(),
  // One-way by design: the chrome mutates over HTTP, where retries, idempotent
  // ids and status codes already live. A frame arriving here is not a protocol
  // we have, so it is dropped rather than guessed at.
  message: () => {},
  idleTimeout: 120,
  sendPings: true,
};

/**
 * Read an SSE body and hand each frame over as (event, data).
 *
 * The hub needs this for exactly one case: a session owned by a DEDICATED
 * server, watched from a shell window. The window upgrades (it is on the hub's
 * origin, where the six-connection pool is the problem), but the hub reaches
 * the inner server over loopback HTTP, where SSE is fine and nothing is
 * capped. So the two wires meet here, and the browser never learns which of
 * its sessions is hosted and which is proxied.
 *
 * Deliberately minimal: it parses the frames THIS codebase writes - no
 * `id:`/`retry:`, no multi-line reassembly beyond joining `data:` lines.
 */
export const pumpSse = async (
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string | null, data: string) => void,
  signal: AbortSignal,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      for (let cut = buffered.indexOf("\n\n"); cut !== -1; cut = buffered.indexOf("\n\n")) {
        const block = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 2);
        let event: string | null = null;
        const data: string[] = [];
        for (const raw of block.split("\n")) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line.startsWith(":")) continue; // a comment, e.g. the ": connected" preamble
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        // A frame with no `data:` carries nothing either wire can deliver.
        if (data.length > 0) onFrame(event, data.join("\n"));
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
};

/** Is this request asking to become a WebSocket? */
export const wantsUpgrade = (req: Request): boolean =>
  req.headers.get("upgrade")?.toLowerCase() === "websocket";

/**
 * Returned by a route that has ALREADY upgraded the connection. Bun's `fetch`
 * must answer `undefined` in that case, but the routing seam is typed
 * `Promise<Response>` and is called directly by tests, so the sentinel keeps
 * that contract honest and the owner translates it at the boundary.
 *
 * Identity, not shape, is the signal - `null` body, so nothing can lock it.
 */
export const UPGRADED: Response = new Response(null, { status: 200 });

export const wasUpgraded = (res: Response): boolean => res === UPGRADED;

/** How a route asks its owning Bun server to take the connection over. */
export type Upgrade = (req: Request, socket: LiveSocket) => boolean;
