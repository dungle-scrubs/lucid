/**
 * Conversations — the single seam that owns the record root and layout.
 *
 * Before, `send`, `watch`, and `run` each re-derived `LUCID_ROOT` and
 * `join(rootDir, conversationId)` and handled `createConversationRecord`
 * vs. open separately - a data clump `(conversationId, rootDir)` that
 * travelled together and a shotgun surgery when the layout changed.
 * Now one module owns `RecordRoot` and the `openOrCreate` discipline;
 * the CLI commands take a `Conversations` and an id, not two strings.
 *
 * What it is NOT: it does not know the flock, the fold, or the TUI -
 * those stay in `src/store/` and `src/tui/`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConversationRecord, type RecordPaths, recordPaths } from "../store/store.js";

export interface Conversations {
  readonly rootDir: string;
  /** Resolve the record directory for `conversationId`. Pure. */
  dirFor(conversationId: string): string;
  /** Resolve the full `RecordPaths` for `conversationId`. Pure. */
  pathsFor(conversationId: string): RecordPaths;
  /** Ensure the record exists, creating it if needed. Returns the
   *  secret (minted or existing) and the dir. */
  ensure(conversationId: string): { secret: string; dir: string };
}

export const conversations = (rootDir?: string): Conversations => {
  const root =
    rootDir ?? process.env.LUCID_ROOT ?? join(process.env.HOME ?? "/tmp", ".lucid", "records");
  return {
    rootDir: root,
    dirFor: (conversationId: string) => join(root, conversationId),
    pathsFor: (conversationId: string) => recordPaths(root, conversationId),
    ensure: (conversationId: string) => {
      try {
        const created = createConversationRecord(root, conversationId);
        return { secret: created.secret, dir: created.paths.dir };
      } catch (e) {
        if (!(e instanceof Error) || !/exists/.test(e.message)) throw e;
        const secretPath = join(root, conversationId, "secret");
        if (!existsSync(secretPath)) throw e;
        const secret = readFileSync(secretPath, "utf8").trim();
        return { secret, dir: join(root, conversationId) };
      }
    },
  };
};
