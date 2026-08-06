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
 *
 * The channel itself lives here too, not just the frame format: `createChannel`
 * owns the subscriber set, the drop-on-throw rule, the stopped-guard and both
 * wires onto it, and `serveLoopback` owns the Bun server the two wires need
 * underneath them. A hub and a per-session server differ in what they
 * BROADCAST, never in how a watcher joins or leaves.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { ServerError } from "../errors.ts";
import { encodeFrame, type LiveFrame, RECONNECT_FRAME } from "../protocol/frames.ts";
import { type LineSink, observeRequests, type RequestObservation } from "./observe.ts";

/**
 * One watcher of a channel, whatever it is wired over. `send` may THROW when
 * the peer is gone (an SSE controller does); every broadcaster catches that
 * and drops the subscriber, which is how a closed stream leaves the set.
 *
 * The WIRE's own vocabulary - a name and an already-encoded string - because
 * this is where a relayed frame passes through opaquely (`pumpSse`). What a
 * broadcaster may actually send is the typed frame union a channel takes
 * (src/protocol/frames.ts).
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

const encoder = new TextEncoder();

/** SSE: the wire format is the frame. A null event is SSE's default `message`. */
const sseSubscriber = (controller: ReadableStreamDefaultController<Uint8Array>): Subscriber => ({
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
const socketSubscriber = (ws: { readonly send: (data: string) => number }): Subscriber => {
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
class LiveSocket {
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
const liveWebSocket: WebSocketHandler<LiveSocket> = {
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
const UPGRADED: Response = new Response(null, { status: 200 });

export const wasUpgraded = (res: Response): boolean => res === UPGRADED;

/** How a route asks its owning Bun server to take the connection over. */
export type Upgrade = (req: Request, socket: LiveSocket) => boolean;

/**
 * Hand a request to the owning Bun server as a WebSocket, carrying the join to
 * run when it opens - or refuse it. Refusing is a useful answer: the socket
 * never opens, so the client backs off and reconnects, which re-runs whatever
 * decision produced this route in the first place.
 */
export const upgradeOrRefuse = (
  req: Request,
  upgrade: Upgrade | undefined,
  join: (sub: Subscriber) => () => void,
): Response =>
  upgrade?.(req, new LiveSocket(join)) === true
    ? UPGRADED
    : new Response(JSON.stringify({ error: "websocket upgrade refused" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      });

/**
 * What a channel does when a watcher arrives or leaves.
 *
 * `J` is whatever the join needs to be decided WITH - the session channel
 * separates agents from windows by it. The subscriber itself is built inside
 * the channel (an SSE controller, a socket), so this is the only way that
 * decision can reach a hook.
 *
 * A dropped peer IS a leave: `onLeave` runs for a subscriber the fan-out threw
 * on, exactly as it does for one that released itself. Bookkeeping that rides
 * on leaving (an agent-presence count) would otherwise survive the peer.
 */
export interface ChannelOptions<F extends LiveFrame, J> {
  /** `send` writes one frame to THIS watcher alone - how a channel primes an
   *  arrival with what it would otherwise wait for the next change to learn. */
  readonly onJoin?: (sub: Subscriber, join: J, send: (frame: F) => void) => void;
  readonly onLeave?: (sub: Subscriber) => void;
}

/** One fan-out set and the two wires reaching it. */
export interface Channel<F extends LiveFrame, J = void> {
  /** Fan one frame out to every watcher. `F` is this channel's whole frame
   *  vocabulary, so a broadcaster cannot invent a name or a payload. */
  readonly send: (frame: F) => void;
  /** Take a watcher on; the returned release takes it back off. */
  readonly subscribe: (sub: Subscriber, join: J) => () => void;
  /** The SSE wire: a response whose body is this channel. */
  readonly sseResponse: (join: J) => Response;
  /** The WebSocket wire: upgrade the request onto this channel, or refuse. */
  readonly handleUpgrade: (req: Request, upgrade: Upgrade | undefined, join: J) => Response;
  /** How many watchers are connected right now. */
  readonly size: () => number;
  /** Close every wire and refuse later joins. Hooks do not run: this is
   *  teardown, not a watcher leaving. Idempotent. */
  readonly stop: () => void;
}

/**
 * A live channel: the subscriber set, the drop-on-throw rule, and both wires
 * onto it. A broadcaster writes one frame and neither wire knows the other
 * exists (see this module's header).
 */
export const createChannel = <F extends LiveFrame, J = void>(
  options: ChannelOptions<F, J> = {},
): Channel<F, J> => {
  const subscribers = new Set<Subscriber>();
  let stopped = false;

  const drop = (sub: Subscriber): void => {
    if (subscribers.delete(sub)) options.onLeave?.(sub);
  };

  // A send that throws is a peer that is gone: drop it, which is the only way
  // an abandoned stream leaves the set. Dropped AFTER the loop, because
  // `onLeave` commonly broadcasts (an agent-presence count) and a fan-out
  // reaching back into the one in flight is how frames interleave.
  const send = (frame: F): void => {
    const wire = encodeFrame(frame);
    const gone: Subscriber[] = [];
    for (const sub of subscribers) {
      try {
        sub.send(wire.event, wire.data);
      } catch {
        gone.push(sub);
      }
    }
    for (const sub of gone) drop(sub);
  };

  const subscribe = (sub: Subscriber, join: J): (() => void) => {
    // This channel may have been torn down since the request was accepted. An
    // upgrade is decided in `fetch` but handed over on `open`, and the owner
    // can stop in that gap - a session host's idle sweep sees no subscribers
    // precisely BECAUSE this one has not landed yet. Joining a stopped channel
    // would leave a socket that is live to the browser and attached to
    // nothing: no frames, and no teardown either, since the set it would be
    // closed from is already clear. So it is turned away and told to come
    // back, which remounts.
    if (stopped) {
      try {
        sub.close();
      } catch {
        // the peer left first; nothing to turn away
      }
      return () => {};
    }
    subscribers.add(sub);
    options.onJoin?.(sub, join, (frame) => {
      const wire = encodeFrame(frame);
      sub.send(wire.event, wire.data);
    });
    return () => drop(sub);
  };

  const sseResponse = (join: J): Response => {
    // Assigned synchronously in `start` before any frame is enqueued; the `!`
    // marks that definite assignment for the `cancel` reader below.
    let leave!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        leave = subscribe(sseSubscriber(controller), join);
      },
      cancel() {
        leave();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  };

  return {
    send,
    subscribe,
    sseResponse,
    handleUpgrade: (req, upgrade, join) =>
      upgradeOrRefuse(req, upgrade, (sub) => subscribe(sub, join)),
    size: () => subscribers.size,
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const sub of subscribers) {
        try {
          sub.close();
        } catch {
          // already closed
        }
      }
      subscribers.clear();
    },
  };
};

export interface LoopbackGate {
  /** Routes served before the gate (the overlay bundle, reachable from the
   *  sandboxed artifact's opaque origin). */
  readonly preGate?: (req: Request) => Response | Promise<Response> | undefined;
  /** Returns a 403 Response if the request fails the Host/Origin DNS-rebind
   *  gate - recording the refusal on the observation so it is attributed
   *  correctly - or undefined if it passes. */
  readonly check: (req: Request, observation: RequestObservation) => Response | undefined;
}

export interface LoopbackOptions {
  /** Ports to try, in order. The first that binds wins. */
  readonly ports: readonly number[];
  /** What this server calls itself in the 500 an escaping throw becomes. */
  readonly name: string;
  /** The one funnel every route passes through. */
  readonly handler: (req: Request, observation: RequestObservation) => Promise<Response>;
  /** Where the wide event per request goes (observe.ts). */
  readonly sink: LineSink;
  /** Run on each request's observation before the gate (M2.2), so a per-server
   *  identity - which session a dedicated server belongs to - attaches even
   *  to pre-gate and refused requests, the way it did when the gate lived in
   *  each handler. */
  readonly attach?: (observation: RequestObservation) => void;
  /** The Host/Origin DNS-rebind gate serveLoopback runs before the handler
   *  (M2.2): the overlay bundle bypasses it, and a 403 records on the
   *  observation. Optional: a gateless stream (the hub listing) sets none. */
  readonly gate?: LoopbackGate;
}

/**
 * Bind a loopback Bun server around one request funnel: the wide-event wrap,
 * the WebSocket handler both servers install, and the `UPGRADED` translation
 * Bun's `fetch` needs.
 *
 * Loopback only, and never an idle timeout: a live channel is a response that
 * is meant to stay open for as long as someone is watching.
 */
export const serveLoopback = (options: LoopbackOptions): ReturnType<typeof Bun.serve> => {
  // The wide event is made HERE, at the one funnel every route passes
  // through (D-004) - no route can forget to log. Built once, not per request.
  const observed = observeRequests(
    { sink: options.sink },
    async (req, observation): Promise<Response> => {
      // attach runs at the observation boundary, before the gate, so a
      // per-server identity rides pre-gate and refused requests too - the
      // invariant the gate owned when it lived in each handler.
      options.attach?.(observation);
      if (options.gate) {
        const pre = await options.gate.preGate?.(req);
        if (pre !== undefined) return pre;
        const blocked = options.gate.check(req, observation);
        if (blocked !== undefined) return blocked;
      }
      return options.handler(req, observation);
    },
  );
  let server: ReturnType<typeof Bun.serve> | undefined;
  let lastErr: unknown;
  for (const candidate of options.ports) {
    try {
      server = Bun.serve({
        port: candidate,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        websocket: liveWebSocket,
        async fetch(req) {
          try {
            const res = await observed(req);
            // The connection is already a WebSocket; Bun wants no Response.
            return wasUpgraded(res) ? undefined : res;
          } catch (err) {
            return new Response(
              JSON.stringify({ error: `${options.name} error: ${(err as Error).message}` }),
              { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
            );
          }
        },
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!server) {
    throw new ServerError({
      message: `could not bind any port in [${options.ports.join(", ")}]: ${(lastErr as Error)?.message ?? "unknown"}`,
    });
  }
  return server;
};
