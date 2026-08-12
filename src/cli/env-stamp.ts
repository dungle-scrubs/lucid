/**
 * Env-stamp + self-invocation — thin adapter over the deep `RecordAddressing`.
 *
 * The stamp is a HINT, not a trust boundary (D-010): `announce`/`inject`
 * MUST verify the resolved record against `meta.json` before writing.
 * The constants, stamp helpers, and `selfInvocation` exec-form builder now
 * live in `src/cli/record-addressing.ts` so `LUCID_RECORD_DIR` is owned
 * once and `resolveVerifiedRecord` no longer re-derives the stamp.
 * This file preserves the original import path (`./env-stamp.js`) and the
 * `self.ts` re-export surface, so existing importers do not churn.
 *
 * What it is NOT: it is not a shell-string interpolator; hook commands
 * and self-invocation both use exec-form argument arrays.
 */

export {
  envStamp,
  LUCID_RECORD_DIR,
  LUCID_TURN_ID,
  readStamp,
  resolveRecordDir,
  selfInvocation,
} from "./record-addressing.js";
