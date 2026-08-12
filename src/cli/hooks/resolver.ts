/**
 * HookRecordResolver — thin adapter over the deep `RecordAddressing`.
 *
 * The `stamp -> dir -> verified identity -> secret` discipline now lives
 * in `src/cli/record-addressing.ts`. This file preserves the original
 * import path (`./resolver.js`) so `announce`, `inject`, and
 * `delivery.ts` keep their import without retargeting, while the deep
 * module is the single owner of the E003 verification. The deletion
 * test: fixing verification now fixes every hook via one module.
 *
 * What it is NOT: it does not know the frame codec, the log, or the
 * append. It is a resolver, not a writer.
 */

export {
  loadSecret,
  type ResolverResult,
  resolveVerifiedRecord,
  type VerifiedRecord,
  verifyRecord,
} from "../record-addressing.js";
