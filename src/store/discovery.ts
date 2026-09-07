import { readdirSync, statSync, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ConversationSummary, DiscoveryIssue } from "../protocol/conversations.js";
import { pathsForDir } from "./errors.js";
import {
  decodeRecordMetadata,
  type RecordMetadata,
  readRecordMetadata,
} from "./record-identity.js";

export interface DiscoveredRecord extends ConversationSummary {
  readonly dir: string;
}
export interface Discovery {
  readonly errors: readonly DiscoveryIssue[];
  readonly records: readonly DiscoveredRecord[];
  readonly identities: ReadonlyMap<string, string>;
}
export class RecordLookupError extends Error {
  override readonly name = "RecordLookupError";
  constructor(
    readonly reason: "ambiguous" | "not-found" | "root-unavailable",
    readonly conversationId: string,
  ) {
    super(`record ${reason}: ${conversationId}`);
  }
}
const availableFolder = (folder: string): boolean => {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
};
const folderField = (value: unknown): string | null =>
  typeof value === "string" && isAbsolute(value) ? value : null;

export function folderSummary(
  value: Record<string, unknown>,
): Pick<ConversationSummary, "projectDirectory" | "workingDirectory" | "workingDirectoryStatus"> {
  const projectDirectory = folderField(value.projectDirectory);
  const workingDirectory = folderField(value.workingDirectory);
  return {
    projectDirectory,
    workingDirectory,
    workingDirectoryStatus:
      workingDirectory === null
        ? "unknown"
        : availableFolder(workingDirectory)
          ? "available"
          : "missing",
  };
}
export const readRecordSummary = (
  dir: string,
  value = readRecordMetadata(dir),
): DiscoveredRecord => {
  if (!statSync(pathsForDir(dir).logPath).isFile()) throw new Error("Record log is unavailable");
  return {
    conversationId: value.conversationId,
    ...(typeof value.conversationTitle === "string"
      ? { conversationTitle: value.conversationTitle }
      : {}),
    dir,
    ...folderSummary(value),
  };
};

/** Cache metadata bytes, never identity decisions: each scan checks current entries and file identity. */
export class DiscoveryIndex {
  private readonly metadata = new Map<string, { fingerprint: string; value: RecordMetadata }>();
  constructor(private readonly root: string) {}
  /** Complete receipt lookup shares metadata fingerprints with listing. Four reads at a time. */
  async receipts(id: string): Promise<readonly { conversationId: string; request: unknown }[]> {
    const entries = (await readdir(this.root, { withFileTypes: true })).filter(
      (entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."),
    );
    const matches: { conversationId: string; request: unknown }[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        for (;;) {
          const entry = entries[next++];
          if (!entry) return;
          const dir = join(this.root, entry.name);
          if (!(await stat(dir)).isDirectory()) continue;
          const info = await stat(pathsForDir(dir).metaPath);
          const fingerprint = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
          const cached = this.metadata.get(dir);
          const value =
            cached?.fingerprint === fingerprint
              ? cached.value
              : decodeRecordMetadata(await readFile(pathsForDir(dir).metaPath, "utf8"));
          this.metadata.set(dir, { fingerprint, value });
          const receipt = value.creation;
          if (receipt && typeof receipt === "object" && "id" in receipt && receipt.id === id) {
            matches.push({
              conversationId: value.conversationId,
              request: "request" in receipt ? receipt.request : null,
            });
          }
        }
      }),
    );
    return matches;
  }
  scan(): Discovery {
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch {
      throw new RecordLookupError("root-unavailable", "");
    }
    const byId = new Map<string, { dir: string; metadata: RecordMetadata }[]>();
    const errors: DiscoveryIssue[] = [];
    const seen = new Set<string>();
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const dir = join(this.root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        seen.add(dir);
        const stat = statSync(pathsForDir(dir).metaPath);
        const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
        const cached = this.metadata.get(dir);
        const metadata =
          cached?.fingerprint === fingerprint ? cached.value : readRecordMetadata(dir);
        this.metadata.set(dir, { fingerprint, value: metadata });
        const matches = byId.get(metadata.conversationId) ?? [];
        matches.push({ dir, metadata });
        byId.set(metadata.conversationId, matches);
      } catch {
        this.metadata.delete(dir);
        errors.push({
          code: "E-HUB-01",
          reason: "unreadable",
          conversationId: null,
          message: `Cannot read record ${name}: metadata is missing, invalid, or inaccessible`,
        });
      }
    }
    for (const dir of this.metadata.keys()) if (!seen.has(dir)) this.metadata.delete(dir);
    const records: DiscoveredRecord[] = [];
    const identities = new Map<string, string>();
    for (const [conversationId, matches] of byId) {
      if (matches.length > 1) {
        errors.push({
          code: "E-HUB-01",
          reason: "ambiguous",
          conversationId,
          message: "More than one record has this identity",
        });
        continue;
      }
      const match = matches[0];
      if (!match) continue;
      identities.set(conversationId, match.dir);
      const invalidFields = ["projectDirectory", "workingDirectory"].filter(
        (field) =>
          match.metadata[field] !== undefined && folderField(match.metadata[field]) === null,
      );
      if (invalidFields.length)
        errors.push({
          code: "E-HUB-01",
          reason: "invalid-folders",
          conversationId,
          message: `Invalid folder metadata: ${invalidFields.join(", ")}. The saved conversation remains readable.`,
        });
      try {
        records.push(readRecordSummary(match.dir, match.metadata));
      } catch {
        errors.push({
          code: "E-HUB-01",
          reason: "unreadable",
          conversationId,
          message: "Record log is unavailable",
        });
      }
    }
    return { errors, records, identities };
  }
}
export const discoverConversations = (root: string): Discovery => new DiscoveryIndex(root).scan();

interface DiscoveryWatchDeps {
  readonly scan?: () => Discovery;
  readonly repeat?: (callback: () => void, milliseconds: number) => () => void;
  readonly observe?: (root: string, callback: () => void) => () => void;
}

/** Watch notifications are hints. The timer rebuilds even with no connected clients. */
export const watchConversations = (root: string, deps: DiscoveryWatchDeps = {}) => {
  let state: Discovery | RecordLookupError;
  let closed = false;
  let pendingHint: ReturnType<typeof setTimeout> | undefined;
  const index = new DiscoveryIndex(root);
  let stopObserving: (() => void) | undefined;
  const refresh = (): Discovery | RecordLookupError => {
    if (closed) return state;
    try {
      state = deps.scan ? deps.scan() : index.scan();
      if (!stopObserving) {
        try {
          stopObserving = deps.observe
            ? deps.observe(root, () => {
                refresh();
              })
            : (() => {
                const watcher = watch(root, () => {
                  if (closed || pendingHint) return;
                  pendingHint = setTimeout(() => {
                    pendingHint = undefined;
                    refresh();
                  }, 50);
                  pendingHint.unref();
                });
                watcher.unref();
                watcher.on("error", () => {
                  watcher.close();
                  stopObserving = undefined;
                });
                return () => watcher.close();
              })();
        } catch {
          /* A missing watcher is recovered by the periodic scan. */
        }
      }
    } catch (cause) {
      if (!(cause instanceof RecordLookupError)) throw cause;
      state = cause;
      stopObserving?.();
      stopObserving = undefined;
    }
    return state;
  };
  refresh();
  const stopRepeating = deps.repeat
    ? deps.repeat(() => {
        refresh();
      }, 5000)
    : (() => {
        const timer = setInterval(refresh, 5000);
        timer.unref();
        return () => clearInterval(timer);
      })();
  return {
    current: () => state,
    refresh,
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(pendingHint);
      stopRepeating();
      stopObserving?.();
      stopObserving = undefined;
    },
  };
};
