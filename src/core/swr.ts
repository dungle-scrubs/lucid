/**
 * Serve the last answer while computing the next one.
 *
 * For work that is a QUERY over slow-moving state - the hub's session listing
 * is a filesystem walk plus a stat per record - where a caller would rather
 * have a slightly old answer now than the exact answer eventually. On an idle
 * machine that listing costs half a second; on one with a backup running, a
 * pegged test process and Spotlight indexing behind it, the same walk measured
 * 40 seconds, and every other request queued behind it (a route touching no
 * disk at all answered in 16s). The shell showed "Looking for sessions…" the
 * whole time, having a perfectly good listing from two seconds earlier.
 *
 * Two properties, and they are the whole point:
 *
 * - **Single flight.** Concurrent callers share ONE computation. Without it a
 *   slow scan invites the next poll to start a second, and a machine already
 *   short of I/O gets N overlapping walks of the same tree.
 * - **A failure does not poison the cache.** If the refresh throws, the last
 *   good value stays servable and the error reaches only the caller that
 *   awaited it. A listing that fails once should not blank a shell.
 */
export interface Swr<T> {
  /** The freshest value that exists, computing one only if none does. Kicks a
   *  background refresh whenever it serves a cached value. */
  readonly cached: () => Promise<T>;
  /** The value as of now: awaits the refresh in flight, or starts one. For
   *  callers whose answer must reflect a change that just happened. */
  readonly fresh: () => Promise<T>;
  /** The cached value without touching anything, or undefined when cold.
   *  For tests and for callers that need to know whether one exists. */
  readonly peek: () => T | undefined;
  /**
   * Drop the cached value, so the next read computes.
   *
   * For a caller that has just CHANGED what the computation would say - added
   * a source, removed one - where serving the previous answer is not staleness
   * but a wrong answer to a question the change just re-asked. Deliberately
   * makes the next reader wait: after an explicit mutation, correct beats
   * quick.
   */
  readonly invalidate: () => void;
}

export const swr = <T>(compute: () => Promise<T>): Swr<T> => {
  let last: T | undefined;
  let inFlight: Promise<T> | null = null;

  const refresh = (): Promise<T> => {
    // `??=` on the promise IS the single flight: a second caller arriving mid
    // computation joins the first rather than starting its own.
    inFlight ??= compute()
      .then((value) => {
        last = value;
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    cached: async () => {
      if (last === undefined) return refresh();
      // Started, not awaited: the caller gets the previous answer now, and the
      // next caller gets this one. A rejection here would be an unhandled
      // rejection, so it is swallowed - the awaiting caller in `fresh` is the
      // one that should see it.
      void refresh().catch(() => {});
      return last;
    },
    fresh: () => refresh(),
    peek: () => last,
    invalidate: () => {
      last = undefined;
    },
  };
};
