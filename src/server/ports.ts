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
  /** Set by Playwright per worker, so the harness gets isolation for free. */
  readonly TEST_WORKER_INDEX?: string | undefined;
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

/** How far to shift every port. Zero means "behave exactly as before". */
export const portBase = (env: PortEnv): number => {
  const explicit = Number.parseInt(env.LUCID_PORT_BASE ?? "", 10);
  if (Number.isFinite(explicit)) return explicit;
  const worker = Number.parseInt(env.TEST_WORKER_INDEX ?? "", 10);
  return Number.isFinite(worker) ? worker * WORKER_STRIDE : 0;
};
