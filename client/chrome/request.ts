/**
 * The chrome's ONE fetch seam (plan 07, M1.3). Every browser request to the
 * hub or a session mount goes through here so every one carries an
 * `x-lucid-request` id - the correlation the hub's request log adopts. A
 * DevTools network row and a `hub.log` line then name the same id, which is
 * the whole join. `test/chrome-request.test.ts` asserts on the source that
 * no other chrome module calls fetch; M2.2 adds the deadline here too.
 *
 * This module owns the header and nothing else - no base-url knowledge, no
 * body shaping, no retry policy.
 */

/** 16 lowercase hex chars, the well-formed shape the hub adopts (R4). */
const mintRequestId = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

export const hubFetch = (input: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("x-lucid-request", mintRequestId());
  return fetch(input, { ...init, headers });
};
