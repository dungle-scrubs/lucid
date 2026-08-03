import type { LogEvent } from "../core/events.ts";
import type { Warning } from "../errors.ts";
import type { HubAttention, HubSessionsResponse } from "./hub.ts";
import type { AttendantPresence, ContextUsage, SelectionResponse } from "./wire.ts";

/**
 * The live frame vocabulary: every named frame the two channels carry - a
 * session's event stream and the hub's listing stream - and the payload under
 * each name.
 *
 * The frames were bare string literals on both sides: eleven names spelled
 * twice, and both decoders dropped a name they did not recognise, so renaming
 * one broke the feature and nothing at all said so. Here they are a
 * discriminated union instead, which the broadcaster's `send` and both client
 * decoders are typed against: an emitter cannot invent a frame, and a decoder
 * cannot quietly drop a field the emitter is already sending (the create
 * turn's exit code rode this wire for months, unread).
 *
 * Frame vocabulary only, and nothing that reads a persisted log: the two frame
 * names, the encoder both wires write through, and the dispatcher both client
 * decoders route with. No runtime imports either - the same rule `wire.ts`
 * keeps, and for the same reason: both sides load this module.
 */

/** The shape every frame shares: the name on the wire, and the payload the
 *  wire carries under it. */
export interface LiveFrame {
  readonly event: string;
  readonly data: unknown;
}

/**
 * The default frame's name.
 *
 * Both wires write it with NO name (SSE's unnamed event; a null `event` in the
 * socket envelope), and a browser reports an unnamed SSE event as `message` -
 * so that is what it is called here, on both sides, and `encodeFrame` drops
 * the name on the way out.
 */
export const DEFAULT_FRAME = "message";

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

/** How many agents are blocked in `wait` on a session right now. */
export interface ListenerCount {
  readonly agents: number;
}

/**
 * A warning frame's payload: an `errors.ts` Warning widened at `code`.
 *
 * The closed union there names the asset and snapshot failures the session
 * server itself raises; the attend engine names delivery failures of its own
 * (a quarantined harness session, a stalled resume), and the viewer resolves
 * the wording by code. So the code set is open on this wire by design, and
 * every `Warning` is one of these.
 */
export interface LiveWarning extends Omit<Warning, "code"> {
  readonly code: string;
}

/**
 * Every frame one session's channel carries.
 *
 * The default frame is the session log itself - one appended event, verbatim.
 * The named ones are SYNTHETIC: facts with no log event behind them (who is
 * listening, whether a terminal has the conversation open) that a viewer must
 * not have to wait for an unrelated append to learn.
 */
export type SessionFrame =
  | { readonly event: typeof DEFAULT_FRAME; readonly data: LogEvent }
  | { readonly event: "listeners"; readonly data: ListenerCount }
  | { readonly event: "presence"; readonly data: AttendantPresence | null }
  | { readonly event: "warning"; readonly data: LiveWarning }
  | { readonly event: "context"; readonly data: ContextUsage }
  | { readonly event: "selection"; readonly data: SelectionResponse };

/** The hub's listing snapshot: the same listing `/hub/sessions` answers, plus
 *  the stamp of the UI build that produced it - a shell that reconnects to a
 *  hub running NEWER chrome than its own reloads itself rather than staying on
 *  the old bundle. */
export interface HubListing extends HubSessionsResponse {
  readonly bundle?: string;
}

/** A create turn that DIED before its artifact surfaced. Keyed state for the
 *  create dialog, not a toast: the dialog is what must stop saying
 *  "authoring…", and say why. */
export interface CreateFailed {
  readonly artifact: string;
  /** The child's exit code, or `spawn-error` when nothing ever ran. */
  readonly code: number | string;
  /** The last few lines of this attempt's log - the harness's own last words. */
  readonly tail: string;
  /** The harness's own usage-limit line, when that is what killed the turn -
   *  the dialog names the wall instead of showing a bare tail. */
  readonly usageLimit?: string;
  /** Which auth wall the turn died on, when it died on one. */
  readonly authFailure?: string;
}

/** A create turn that is STILL RUNNING (M2.1) - the positive signal, so the
 *  dialog reports progress instead of inferring failure from a clock. */
export interface CreateProgress {
  readonly artifact: string;
  /** The click's request id, so a heartbeat and the click's own request record
   *  join with one grep. */
  readonly trace: string;
  readonly elapsedMs: number;
  /** The turn's own phase one-liner (`lucid progress --label`), when it
   *  narrated one. */
  readonly label?: string;
}

/**
 * Every frame the hub's listing channel carries.
 *
 * The default frame is the listing; the rest are the news a shell cannot poll
 * for - a session opened from a terminal, a create turn's heartbeat and its
 * death, and the liveness tick a window measures silence against.
 */
export type HubFrame =
  | { readonly event: typeof DEFAULT_FRAME; readonly data: HubListing }
  | { readonly event: "attention"; readonly data: Readonly<Record<string, HubAttention>> }
  | { readonly event: "tick"; readonly data: null }
  | { readonly event: "open-tab"; readonly data: { readonly id: string } }
  | { readonly event: "create-failed"; readonly data: CreateFailed }
  | { readonly event: "create-progress"; readonly data: CreateProgress };

/** The payload one named frame carries - what a decoder holding the name gets
 *  to assume, and nothing more. */
export type FrameData<F extends LiveFrame, E extends F["event"]> = Extract<
  F,
  { readonly event: E }
>["data"];

/** One handler per frame a channel can send. A MAP rather than a switch,
 *  because the keys are the union's own names: rename a frame on the server and
 *  this fails to compile, where a switch simply stopped matching. */
export type FrameHandlers<F extends LiveFrame> = {
  readonly [E in F["event"]]: (data: FrameData<F, E>) => void;
};

/** Route one decoded frame to its handler. A name this build does not know is
 *  ignored - an older window against a newer hub, which is not an error. */
export const dispatchFrame = <F extends LiveFrame>(
  handlers: FrameHandlers<F>,
  event: string,
  data: string,
): void => {
  if (!Object.hasOwn(handlers, event)) return;
  (handlers as Record<string, (payload: unknown) => void>)[event]?.(JSON.parse(data));
};

/** One frame as both wires carry it: SSE's own form, a name and a JSON string.
 *  The default frame goes out unnamed, which is what makes it the default. */
export const encodeFrame = (
  frame: LiveFrame,
): { readonly event: string | null; readonly data: string } => ({
  event: frame.event === DEFAULT_FRAME ? null : frame.event,
  data: JSON.stringify(frame.data),
});
