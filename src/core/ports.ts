/**
 * Where Lucid's loopback ports come from.
 *
 * Every port here is machine-global by design: a session reopened tomorrow
 * should land on the URL the browser already has, and the hub's Dock icon must
 * point somewhere that does not rotate. That is the right trade for one human
 * on one machine, and exactly wrong for a test suite running four workers at
 * once, where two sessions racing for 17412 is not a bug either of them can see.
 *
 * So the numbers stay fixed and gain a single offset. Nothing shifts unless
 * something asks, which keeps the default identical to the behaviour that
 * existed before this module.
 */

/** Environment this module reads. Passed in rather than reached for, so the
 *  choice is testable and so a caller can show what it decided. */
export interface PortEnv {
  /** An explicit offset, which wins over everything else. */
  readonly LUCID_PORT_BASE?: string | undefined;
  /**
   * Playwright's per-worker slot, 0..workers-1, and REUSED when a worker is
   * restarted after a failure. Deliberately not `TEST_WORKER_INDEX`, which is
   * unique-forever and climbs on every restart: this milestone's suites SIGKILL
   * servers on purpose, so workers do get replaced, and a base derived from the
   * unique index would wander further from the defaults with every crash - into
   * whatever else is on the machine, differently on every run. That is the
   * failure this offset exists to eliminate, reintroduced by picking the wrong
   * variable.
   */
  readonly TEST_PARALLEL_INDEX?: string | undefined;
  /** Present so `process.env` is assignable: an interface of only optional
   *  properties is a "weak type", which TypeScript refuses to match against
   *  `ProcessEnv`. The two above are the ones actually read. */
  readonly [other: string]: string | undefined;
}

/**
 * Distance between one worker's ports and the next worker's.
 *
 * Wide enough to clear everything a single worker binds: the eight preferred
 * session ports (17412-17419) and the hub (17428). At 20, worker N's hub lands
 * at 17428+20N, still below worker N+1's first session port at 17432+20N, so no
 * two workers can meet on any port. `noWorkerSharesAPort` in the tests is the
 * check that keeps that true if these numbers ever move.
 */
const WORKER_STRIDE = 20;

/**
 * Preferred per-session ports, tried in order before falling back to `0`
 * (ephemeral). A stable port keeps a reopened session on the URL the browser
 * already has; the trailing `0` guarantees a session still starts when every
 * preferred port is taken.
 */
const BASE_PORT_POOL: readonly number[] = [
  17412, 17413, 17414, 17415, 17416, 17417, 17418, 17419, 0,
];

/**
 * This worker's preferred session ports.
 *
 * The trailing `0` is left alone deliberately. It is not a port - it means "ask
 * the OS for whatever is free", and it is the reason a session still starts
 * when all eight preferred ports are busy. Shifting it would turn the escape
 * hatch into just another fixed port that can itself be taken, and it would
 * only fail under the parallel load this offset exists to make possible.
 */
export const sessionPortPool = (base: number): readonly number[] =>
  BASE_PORT_POOL.map((port) => (port === 0 ? 0 : port + base));

/**
 * The always-on hub's port.
 *
 * One fixed number is the entire point of it: the shell keeps ONE stable entry
 * URL, because a Dock icon pinned to a rotating per-session port would go stale
 * and 17428 never does. The offset is for test workers only, which is why the
 * default is unchanged.
 */
export const hubPort = (base: number): number => 17428 + base;

/**
 * The largest offset that still leaves every port bindable.
 *
 * The hub is the highest number here, so it sets the ceiling: 17428 + base must
 * stay inside the 16-bit port space.
 */
const MAX_BASE = 65535 - 17428;

/**
 * A whole non-negative integer, or undefined - and nothing in between.
 *
 * `Number.parseInt` is far too forgiving to read configuration with: it takes
 * the leading digits and discards the rest, so `1e3` is 1 and `20abc` is 20.
 * Someone who meant a thousand would get one, every port would be off by 999,
 * and the only symptom would be a session on a port they did not expect. A
 * value that is not simply a number is a mistake worth naming.
 */
const strictInt = (raw: string | undefined): number | undefined =>
  raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;

/**
 * How far to shift every port. Zero means "behave exactly as before".
 *
 * Refuses rather than returns nonsense. An out-of-range base produces ports
 * outside the 16-bit space, and the failure that follows is `Bun.serve`
 * rejecting a number with no hint of where it came from - a bind error three
 * layers from the environment variable that caused it. Better to say so here.
 */
export const portBase = (env: PortEnv): number => {
  const raw = env.LUCID_PORT_BASE?.trim();
  if (raw !== undefined && raw !== "") {
    const explicit = strictInt(raw);
    if (explicit === undefined) {
      throw new RangeError(
        `LUCID_PORT_BASE must be a whole number, got ${JSON.stringify(raw)}. ` +
          'Partial parses are refused on purpose: "1e3" would silently mean 1.',
      );
    }
    if (explicit > MAX_BASE) {
      throw new RangeError(
        `LUCID_PORT_BASE ${explicit} would put the hub on ${17428 + explicit}, ` +
          `past the highest port there is. The most it can be is ${MAX_BASE}.`,
      );
    }
    return explicit;
  }
  const slot = strictInt(env.TEST_PARALLEL_INDEX);
  if (slot === undefined) return 0;
  const derived = slot * WORKER_STRIDE;
  // Clamped rather than thrown: the runner set this, not a human, so the useful
  // response to an implausible slot is to stop shifting rather than to take the
  // whole run down. It cannot happen with a sane `workers` setting.
  return derived > MAX_BASE ? 0 : derived;
};
