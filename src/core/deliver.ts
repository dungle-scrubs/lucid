import { discoverLiveServer, loopbackFetch } from "../server/discovery.ts";
import { cliRequestId } from "../server/observe.ts";
import type { EventInput, LogEventType } from "./events.ts";
import { appendEvent } from "./log.ts";
import type { SessionPaths } from "./paths.ts";
import { REQUEST_ID_HEADER } from "./request-id.ts";

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
  question: "/__lucid/question",
  session_ended: "/__lucid/end",
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
      // the request that caused the turn.
      headers: { "content-type": "application/json", [REQUEST_ID_HEADER]: cliRequestId() },
      body: JSON.stringify(body),
    });
    return { live: true };
  }
  await appendEvent(paths.logPath, input);
  return { live: false };
};
