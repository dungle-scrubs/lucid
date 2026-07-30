/**
 * The chrome's ONE fetch seam (plan 07, M1.3). Every browser fetch to the
 * hub or a session mount goes through here so every one carries an
 * `x-lucid-request` trace - the correlation the hub's request log adopts. A
 * DevTools network row and a `hub.log` line then name the same value, which
 * is the whole join. `test/chrome-request.test.ts` asserts on the source
 * that no other chrome module calls fetch; M2.2 adds the deadline here too.
 *
 * Fetch only: the two EventSource streams (hub events, session stream)
 * cannot carry headers, and the hub records their arrival with a minted id
 * instead. This module owns stamping the header and nothing else - no
 * base-url knowledge, no body shaping, no retry policy.
 */

import { mintRequestId, REQUEST_ID_HEADER } from "../../src/core/request-id.ts";

export const hubFetch = (input: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set(REQUEST_ID_HEADER, mintRequestId());
  return fetch(input, { ...init, headers });
};
