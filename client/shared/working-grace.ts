/**
 * The working-grace constant re-export for the chrome (M4.5): the working clock
 * reads `WORKING_GRACE_MS` through THIS door rather than importing
 * `src/core/fold.ts` directly. The constant stays defined in fold.ts (attend.ts
 * imports it from there); Phase 5 moves attend.ts to the shared home and this
 * re-export becomes the definition.
 */
export { WORKING_GRACE_MS } from "../../src/core/fold.ts";
