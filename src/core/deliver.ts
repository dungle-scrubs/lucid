import { discoverLiveServer, loopbackFetch } from "../server/discovery.ts";
import { LUCID_ROUTES } from "../protocol/routes.ts";
import { mutateAttendantSidecar, readPendingAttendants } from "./attendant.ts";
import {
  bindingEventId,
  hasId,
  type AttendantStamp,
  type EventInput,
  type LogEvent,
  type LogEventType,
} from "./events.ts";
import { appendEvent, appendEventsIf } from "./log.ts";
import type { SessionPaths } from "./paths.ts";

/**
 * Deliver a CLI-authored event to the session. The one rule every command must
 * follow, stated once: POST to the live server when there is one - the server
 * is the sole appender of an active session and broadcasting to its SSE
 * subscribers is what makes the viewer react - and only fall back to a direct
 * append under the exclusive log lock (D-049) when no server answers.
 */

/** Server route per deliverable event type (M1.5): the spellings live in
 *  `LUCID_ROUTES`; this maps each CLI-deliverable event type to its route.
 *  The handlers read the event body minus `t`, so one POST shape serves them. */
const ROUTES: Partial<Record<LogEventType, string>> = {
  agent_reply: LUCID_ROUTES.reply,
  agent_ack: LUCID_ROUTES.ack,
  agent_turn_ended: LUCID_ROUTES.turnEnded,
  question: LUCID_ROUTES.question,
  session_ended: LUCID_ROUTES.end,
  harness_session_bound: LUCID_ROUTES.bind,
};

/**
 * The one live-delivery seam (M1.4, D-005): discover the live server, POST the
 * body to the route, and report which of three outcomes happened. The CALLER
 * owns the policy by pattern-matching the result - this never decides what a
 * live failure means, because the three callers mean three different things:
 *
 * - `ignore` (deliver): a live failure is an error (rethrow); only a truly
 *   offline server falls back to a direct append.
 * - `fallbackOffline` (runContext): offline OR live-failure both fall back to a
 *   SIDECAR write - never a log append (enforced by the caller's own action).
 * - `keepOwed` (promotePendingBindings): a live failure leaves the binding owed
 *   (no fallback, no error); only offline appends directly.
 *
 * Centralizing discover+POST here is what keeps those three policies from
 * drifting apart as the fourth hand-rolled copy once did. The trace header is
 * stamped by `loopbackFetch` itself, so every live delivery stays joinable to
 * the click that caused it without each call site remembering.
 */
export type LiveDelivery =
  | { readonly live: true }
  | { readonly live: false; readonly reason: "offline" }
  | { readonly live: false; readonly reason: "live-failure"; readonly error: unknown };

export const deliverToLive = async (
  paths: SessionPaths,
  route: string,
  body: unknown,
): Promise<LiveDelivery> => {
  const live = await discoverLiveServer(paths);
  if (!live) return { live: false, reason: "offline" };
  try {
    const res = await loopbackFetch(live.port, `${live.base ?? ""}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`live POST ${route} returned ${res.status}`);
    return { live: true };
  } catch (error) {
    return { live: false, reason: "live-failure", error };
  }
};

export interface DeliverResult {
  /** True when a live server took the event (and broadcast it). */
  readonly live: boolean;
  /** Binding fallback only: the log holds no `session_opened` yet, so the
   *  event was refused rather than appended - the binding is still owed. */
  readonly refused?: boolean;
}

export interface BindingInput {
  readonly launchId: string;
  readonly attendant: AttendantStamp;
  readonly turnId?: string;
}

export interface BindingAppendResult {
  /** False when the log holds no `session_opened` yet: the binding is still
   *  owed, nothing was written. */
  readonly opened: boolean;
  /** The binding events that are NEW in this append - a re-announced binding
   *  dedupes to [] here even though the log returns the pre-existing event. */
  readonly fresh: readonly LogEvent[];
}

/**
 * The ONE writer of `harness_session_bound` at the log level: derives the
 * idempotency id from (launchId, sessionId), enforces the after-open guard,
 * and reports which events are genuinely NEW - all inside the append lock, so
 * none of it can race a concurrent announce. Three paths used to build this
 * event themselves and each enforced a different subset of its invariants.
 */
export const appendSessionBindings = async (
  paths: SessionPaths,
  bindings: readonly BindingInput[],
): Promise<BindingAppendResult> => {
  const inputs: EventInput[] = [];
  for (const b of bindings) {
    if (!b.attendant.sessionId || !b.attendant.sessionIdAuthority) continue;
    inputs.push({
      t: "harness_session_bound",
      id: bindingEventId(b.launchId, b.attendant.sessionId),
      launchId: b.launchId,
      ...(b.turnId ? { turnId: b.turnId } : {}),
      attendant: b.attendant,
    });
  }
  if (inputs.length === 0) return { opened: true, fresh: [] };
  let opened = false;
  const existing = new Set<string>();
  const appended = await appendEventsIf(
    paths,
    (events) => {
      opened = events.some((e) => e.t === "session_opened");
      for (const e of events) if (hasId(e)) existing.add(e.id);
      return opened;
    },
    inputs,
  );
  return {
    opened,
    fresh: appended.filter((e): e is LogEvent => hasId(e) && !existing.has(e.id)),
  };
};

export const deliver = async (paths: SessionPaths, input: EventInput): Promise<DeliverResult> => {
  const route = ROUTES[input.t];
  if (route === undefined) {
    throw new Error(`event type ${input.t} is not CLI-deliverable`);
  }
  // `ignore` policy (M1.4, D-005): a live failure is an error (the turn's write
  // must land somewhere or be seen to fail - a silent fall-through to a direct
  // append would double-append over a server that is in fact still taking it);
  // only a truly offline server falls back to the direct append below. The
  // trace is stamped by `loopbackFetch` inside the seam.
  const { t: _t, ...body } = input;
  const outcome = await deliverToLive(paths, route, body);
  if (outcome.live) return { live: true };
  if (outcome.reason === "live-failure") throw outcome.error;
  if (input.t === "harness_session_bound") {
    // Through the one binding writer, so the offline fallback carries the
    // same after-open guard and derived id as every other producer. A refusal
    // is visible to the caller rather than a silent skip.
    const result = await appendSessionBindings(paths, [
      { launchId: input.launchId, attendant: input.attendant, turnId: input.turnId },
    ]);
    return { live: false, ...(result.opened ? {} : { refused: true }) };
  }
  await appendEvent(paths, input);
  return { live: false };
};

/**
 * Promote identity discovered BEFORE the review log existed: for every sidecar
 * still holding a pending binding, land the durable `harness_session_bound`
 * and clear the flag.
 *
 * Landing honors the one-appender rule: a live server takes the binding over
 * POST (and broadcasts it); only with no server does this append directly,
 * guarded on the log already holding a `session_opened` - a binding is news
 * ABOUT a session, so it never precedes the event that creates one. The flag
 * is cleared only when the sidecar STILL holds the identity that was just
 * promoted: an identity re-recorded mid-promotion stays pending for the next
 * pass instead of being silently dropped.
 */
export const promotePendingBindings = async (paths: SessionPaths): Promise<readonly LogEvent[]> => {
  const pending = await readPendingAttendants(paths);
  if (pending.length === 0) return [];
  const promoted: LogEvent[] = [];
  for (const attendant of pending) {
    const { harness, sessionId, sessionIdAuthority, launchId } = attendant;
    if (!sessionId || !sessionIdAuthority || !launchId) continue;
    const stamp: AttendantStamp = { harness, sessionId, sessionIdAuthority };
    // `keepOwed` policy (M1.4, D-005) through the one seam: a live server takes
    // the binding over POST; only offline appends directly (guarded on open);
    // a live FAILURE (the server that answered discovery then refused or died)
    // leaves the binding owed - clearing the flag on it would lose the identity.
    const outcome = await deliverToLive(paths, "/__lucid/bind", { launchId, attendant: stamp });
    if (!outcome.live) {
      if (outcome.reason === "live-failure") continue; // keep owed
      const result = await appendSessionBindings(paths, [{ launchId, attendant: stamp }]);
      if (!result.opened) continue; // not opened yet: still owed
      promoted.push(...result.fresh);
    }
    await mutateAttendantSidecar(paths, harness, (current) => {
      // Only the identity we just promoted stops being pending; a NEWER
      // identity recorded while we were appending keeps its flag.
      if (
        current?.pendingBinding &&
        current.launchId === launchId &&
        current.sessionId === sessionId
      ) {
        const { pendingBinding: _cleared, ...rest } = current;
        return rest;
      }
      return current ?? { at: new Date().toISOString(), harness };
    });
  }
  return promoted;
};
