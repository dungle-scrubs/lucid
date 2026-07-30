/**
 * The chrome's ONE fetch seam (plan 07, M1.3 + M2.2). Every browser fetch to
 * the hub or a session mount goes through here, so every one carries an
 * `x-lucid-request` trace AND a deadline. A DevTools network row and a
 * `hub.log` line name the same trace, which is the whole join; the deadline
 * is what stops "no answer" from being indistinguishable from "still
 * working" - seven of the ten call sites could not tell those apart.
 *
 * Fetch only: the two EventSource streams (hub events, session stream)
 * cannot carry headers, and the hub records their arrival with a minted id
 * instead. This module owns the header, the deadline and the message that
 * names the likely cause - no base-url knowledge, no body shaping, no retry
 * policy.
 */

import { mintRequestId, REQUEST_ID_HEADER } from "../../src/core/request-id.ts";

/**
 * The default deadline. Every hub route is loopback and answers in
 * milliseconds; the exceptions that legitimately take longer pass their own
 * `timeoutMs` rather than opting out of being bounded.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * For routes whose work is a RECURSIVE FILESYSTEM SCAN, not a lookup. Adding
 * a broad folder walks it serially: measured at 16s for a whole home
 * directory, which the default deadline aborted - and aborting is worse than
 * useless there, because the hub persists the root BEFORE it scans, so the
 * human saw "the hub did not answer" for an add that had in fact succeeded.
 * Bounded, not exempt: a scan that takes minutes is still a broken scan.
 */
export const SCAN_TIMEOUT_MS = 120_000;

export interface HubFetchInit extends RequestInit {
  /**
   * Override the deadline, or pass `null` for the ONE documented exemption:
   * a request that waits on a human. The folder chooser opens a native
   * dialog and a person browsing folders is slow on purpose, so a deadline
   * there would abort a working interaction. The hub's own chooser guard
   * bounds that request instead.
   */
  readonly timeoutMs?: number | null;
}

/** What a caller sees when nothing answered: a cause, not a stack. */
export class HubUnreachableError extends Error {
  constructor(path: string) {
    super(
      `The hub did not answer ${path} in time. It may have stopped, or been restarted - reload the page.`,
    );
    this.name = "HubUnreachableError";
  }
}

export const hubFetch = (input: string, init: HubFetchInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set(REQUEST_ID_HEADER, mintRequestId());
  const { timeoutMs, ...rest } = init;
  const budget = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  // Composed, not replaced: a caller's own signal must still abort, so both
  // are live and whichever fires first wins.
  const deadline = budget === null ? undefined : AbortSignal.timeout(budget);
  const signal =
    deadline === undefined
      ? init.signal
      : init.signal
        ? AbortSignal.any([init.signal, deadline])
        : deadline;
  return fetch(input, { ...rest, headers, ...(signal ? { signal } : {}) }).catch(
    (err: unknown): never => {
      // Only OUR deadline becomes the unreachable message; a caller's own
      // abort is their business and keeps its own reason.
      if (deadline?.aborted === true && init.signal?.aborted !== true) {
        throw new HubUnreachableError(input);
      }
      throw err;
    },
  );
};
