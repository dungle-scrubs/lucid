/**
 * Conversations — thin adapter over the deep `RecordAddressing` module.
 *
 * The `RecordRoot` and `openOrCreate` discipline now lives in
 * `src/cli/record-addressing.ts`. This file preserves the original import
 * path (`./conversations.js`) so `send`, `watch`, `run`, and tests keep
 * their seam without retargeting, while the deep module is the single
 * owner of `LUCID_ROOT` -> `join(root, id)` + `createConversationRecord`
 * fallback. The deletion test: this file should be deletable with only
 * import-path updates; all bug fixes belong in `record-addressing.ts`.
 *
 * What it is NOT: it does not know the flock, the fold, or the TUI.
 */

export type { RecordPaths } from "./record-addressing.js";
export { type Conversations, conversations } from "./record-addressing.js";
