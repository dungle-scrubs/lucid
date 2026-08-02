import { discoverLiveServer, loopbackFetch } from "../server/discovery.ts";
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

/** Server route per deliverable event type. The handlers read the event body
 *  minus `t`, so one POST shape serves them all. */
const ROUTES: Partial<Record<LogEventType, string>> = {
  agent_reply: "/__lucid/reply",
  agent_ack: "/__lucid/ack",
  agent_turn_ended: "/__lucid/turn-ended",
  question: "/__lucid/question",
  session_ended: "/__lucid/end",
  harness_session_bound: "/__lucid/bind",
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
  logPath: string,
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
    logPath,
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
  const live = await discoverLiveServer(paths);
  if (live) {
    const { t: _t, ...body } = input;
    await loopbackFetch(live.port, `${live.base ?? ""}${route}`, {
      method: "POST",
      // The turn's WRITE joins the click that spawned it (plan 07 #9): without
      // the trace, the record for a reply is an orphan line no grep can tie to
      // the request that caused the turn. `loopbackFetch` stamps it - carrying
      // it here too would say the call site owns it, which is the arrangement
      // that let an untraced fourth caller exist (plan 08, finding #15).
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { live: true };
  }
  if (input.t === "harness_session_bound") {
    // Through the one binding writer, so the offline fallback carries the
    // same after-open guard and derived id as every other producer. A refusal
    // is visible to the caller rather than a silent skip.
    const result = await appendSessionBindings(paths.logPath, [
      { launchId: input.launchId, attendant: input.attendant, turnId: input.turnId },
    ]);
    return { live: false, ...(result.opened ? {} : { refused: true }) };
  }
  await appendEvent(paths.logPath, input);
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
  const live = await discoverLiveServer(paths);
  const promoted: LogEvent[] = [];
  for (const attendant of pending) {
    const { harness, sessionId, sessionIdAuthority, launchId } = attendant;
    if (!sessionId || !sessionIdAuthority || !launchId) continue;
    const stamp: AttendantStamp = { harness, sessionId, sessionIdAuthority };
    if (live) {
      try {
        const res = await loopbackFetch(live.port, `${live.base ?? ""}/__lucid/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ launchId, attendant: stamp }),
        });
        // A refusal is not a landing: a 409 (not opened yet) or a 400
        // (malformed) leaves the binding owed, and clearing the pending flag
        // on it would lose the identity for good.
        if (!res.ok) continue;
      } catch {
        continue; // the server died; the binding stays owed
      }
    } else {
      const result = await appendSessionBindings(paths.logPath, [{ launchId, attendant: stamp }]);
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
