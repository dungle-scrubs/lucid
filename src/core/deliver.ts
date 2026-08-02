import { discoverLiveServer, loopbackFetch } from "../server/discovery.ts";
import { mutateAttendantSidecar, readPendingAttendants } from "./attendant.ts";
import { bindingEventId, type EventInput, type LogEvent, type LogEventType } from "./events.ts";
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
}

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
    // A binding is news ABOUT an open session: the direct fallback keeps the
    // same after-open guard the promotion path enforces, so a binding can
    // never become a log's first line.
    await appendEventsIf(paths.logPath, (events) => events.some((e) => e.t === "session_opened"), [
      input,
    ]);
    return { live: false };
  }
  await appendEvent(paths.logPath, input);
  return { live: false };
};

/**
 * Promote identity discovered BEFORE the review log existed: for every sidecar
 * still holding a pending binding, append the durable `harness_session_bound`
 * through the normal locked path and clear the flag.
 *
 * Guarded on the log already holding a `session_opened` - a binding is news
 * ABOUT a session, so it never precedes the event that creates one; before
 * open, the sidecar keeps owing it and the call is a no-op. Idempotent twice
 * over: the guard-side dedupe by binding id means a re-discovered identity
 * lands once, and a cleared flag means a promoted sidecar stops volunteering.
 */
export const promotePendingBindings = async (paths: SessionPaths): Promise<readonly LogEvent[]> => {
  const pending = await readPendingAttendants(paths);
  if (pending.length === 0) return [];
  const promoted: LogEvent[] = [];
  for (const attendant of pending) {
    // The reads in readPendingAttendants proved these present; the types
    // carry them as optional because an ordinary sidecar may omit them.
    const { harness, sessionId, sessionIdAuthority, launchId } = attendant;
    if (!sessionId || !sessionIdAuthority || !launchId) continue;
    const appended = await appendEventsIf(
      paths.logPath,
      (events) => events.some((e) => e.t === "session_opened"),
      [
        {
          t: "harness_session_bound",
          id: bindingEventId(launchId, sessionId),
          launchId,
          attendant: { harness, sessionId, sessionIdAuthority },
        },
      ],
    );
    if (appended.length === 0) continue; // not opened yet: still owed
    promoted.push(...appended);
    await mutateAttendantSidecar(paths, harness, (current) => {
      const { pendingBinding: _cleared, ...rest } = current ?? {
        at: new Date().toISOString(),
        harness,
      };
      return rest;
    });
  }
  return promoted;
};
