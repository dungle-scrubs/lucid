/**
 * The fixed-hub port offset, alone in its own module.
 *
 * It lives here rather than in `hub.ts` because `hub.ts` imports
 * `@playwright/test` at the top level, and a `bun test` file that imports that
 * dies on Playwright's runner guard - which would leave the collision property
 * below unpinnable from the unit suite, where the drift guards live. A pure
 * constant in a pure module is importable from both worlds.
 *
 * The property, pinned by `test/ports.test.ts`: this offset MUST NOT be a
 * multiple of the 20-port worker stride. 100 = 5 x 20 put slot N's fixed hub
 * on slot N+5's DEFAULT hub port, so at six workers one worker's
 * `killHubOnPort` SIGKILLed another's ordinary hub mid-test (M6.2 review, F1).
 */
export const FIXED_HUB_BASE_OFFSET = 110;

/** The per-slot stride `src/server/ports.ts` uses, restated for the guard. */
export const WORKER_STRIDE = 20;
