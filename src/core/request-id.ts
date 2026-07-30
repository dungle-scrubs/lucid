/**
 * The request-id vocabulary, shared by every hop (plan 07, M1.3/D-011): the
 * server's boundary (src/server/observe.ts) and the chrome's one fetch seam
 * (client/chrome/request.ts) both import THIS module, so the header name,
 * the well-formed shape and the mint cannot drift apart - a one-sided tweak
 * would silently unjoin the browser from the hub's records. Pure: no fs, no
 * env, browser-safe.
 */

/** The header the trace travels on, every hop: browser -> hub, CLI -> hub. */
export const REQUEST_ID_HEADER = "x-lucid-request";

/** Exactly 16 lowercase hex chars - anchored, fixed width. Anything else is
 *  REFUSED, never sanitised-and-kept: an arbitrary-length or non-hex value
 *  must not reach a log line (R4, the log-injection guard). */
export const WELL_FORMED_ID = /^[a-f0-9]{16}$/;

/** A fresh id: 16 hex chars, the same width `sessionId` uses. */
export const mintRequestId = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
