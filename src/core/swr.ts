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
 * Three properties, and they are the whole point:
 *
 * - **One walk at a time, always.** Every path here either joins the
 *   computation in flight or waits for it to finish; none starts a second one
 *   beside it. A machine already short of I/O is where this matters, and it is
 *   also the machine where every computation is slow enough for the overlap to
 *   happen. It holds across `invalidate` too, which is the hard case: the walk
 *   in flight is reading sources that have just changed, so it can neither be
 *   handed to a reader nor be raced.
 * - **A failure does not poison the cache.** If the refresh throws, the last
 *   good value stays servable and the error reaches only the caller that
 *   awaited it. A listing that fails once should not blank a shell.
 * - **A computation answers for the world it started in.** `fresh` and
 *   `invalidate` both exist for a caller that just CHANGED that world, so
 *   neither may be satisfied by a walk that began before the change.
 */
export interface Swr<T> {
  /** The freshest value that exists, computing one only if none does. Kicks a
   *  background refresh whenever it serves a cached value. */
  readonly cached: () => Promise<T>;
  /**
   * The value as of NOW: never one computed before this call.
   *
   * A computation already under way started before the caller asked, so its
   * answer can predate the change that made them ask - joining it is how a
   * "fresh" read quietly returns the old world. This waits for that one to
   * land and then takes the computation after it. Two walks end to end, so it
   * is for callers who have actually changed something, not for polling.
   */
  readonly fresh: () => Promise<T>;
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

export interface SwrOptions {
  /**
   * How old the cached value must be before a read kicks a refresh behind it.
   *
   * Without one, every read starts a walk the moment the previous finishes, so
   * a busy disk simply never stops walking - and if something else already
   * refreshes on a timer, none of those walks buys any freshness. Set it to
   * that timer's period. It never delays `fresh`, and it never makes a read
   * WAIT - it only declines to start work that would answer a question nobody
   * has asked yet.
   */
  readonly minAgeMs?: number;
}

export const swr = <T>(compute: () => Promise<T>, opts: SwrOptions = {}): Swr<T> => {
  // Boxed rather than `T | undefined`: `undefined` is a legitimate T, and a
  // bare sentinel would leave `swr<Foo | undefined>` recomputing on every
  // read - the exact cost this exists to avoid, failing silently.
  let last: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;
  // The era each of those belongs to. `invalidate` bumps `era`; a computation
  // reads the world as it stands when it STARTS, so one begun in an earlier
  // era cannot answer for this one.
  let era = 0;
  let inFlightEra = 0;

  const start = (): Promise<T> => {
    const startedIn = era;
    const run: Promise<T> = compute().then(
      (value) => {
        // A walk of sources that have since been replaced answers a question
        // nobody is asking any more; it must not become the cached answer.
        if (startedIn === era) last = { value, at: Date.now() };
        if (inFlight === run) inFlight = null;
        return value;
      },
      (err: unknown) => {
        if (inFlight === run) inFlight = null;
        throw err;
      },
    );
    inFlight = run;
    inFlightEra = startedIn;
    return run;
  };

  /** Wait out the walk in flight - joining it, never racing it - and then take
   *  whichever walk comes after: one another caller has since started, or a
   *  new one. */
  const afterInFlight = async (): Promise<T> => {
    const running = inFlight;
    // Its outcome is not this caller's business, only its finishing is.
    if (running) await running.catch(() => {});
    return inFlight ?? start();
  };

  return {
    cached: async () => {
      if (last !== null) {
        const due = opts.minAgeMs === undefined || Date.now() - last.at >= opts.minAgeMs;
        // Started, not awaited: the caller gets the previous answer now, and
        // the next caller gets this one. A rejection here would be an
        // unhandled rejection, so it is swallowed - the awaiting caller in
        // `fresh` is the one that should see it.
        if (due && inFlight === null) void start().catch(() => {});
        return last.value;
      }
      // Nothing servable: either cold, or `invalidate` emptied it. A walk from
      // an earlier era cannot answer the question that emptied the cache, so
      // wait it out rather than be handed it.
      if (inFlight !== null && inFlightEra !== era) return afterInFlight();
      return inFlight ?? start();
    },
    fresh: afterInFlight,
    invalidate: () => {
      last = null;
      // The walk in flight is reading the sources that just changed. Ending
      // its era is enough to keep its answer out of the cache; it is left
      // running rather than abandoned, so the reader that waits for it is
      // still waiting for the only walk there is.
      era += 1;
    },
  };
};
