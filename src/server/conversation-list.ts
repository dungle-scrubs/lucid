import { stat } from "node:fs/promises";
import type {
  ConversationPage,
  DiscoveryIssue,
  ListedConversation,
} from "../protocol/conversations.js";
import { readConversationTitle } from "../store/conversation-label.js";
import type { DiscoveredRecord, Discovery } from "../store/discovery.js";
import { pathsForDir } from "../store/errors.js";

type Entry = { readonly key: string; readonly record: DiscoveredRecord };

export const createConversationListing = () => {
  const labels = new Map<string, { fingerprint: string; title: Promise<string> }>();
  const label = async (dir: string, saved?: string): Promise<string> => {
    const file = await stat(pathsForDir(dir).logPath);
    const fingerprint = JSON.stringify([
      file.dev,
      file.ino,
      file.size,
      file.mtimeMs,
      file.ctimeMs,
      saved,
    ]);
    const cached = labels.get(dir);
    if (cached?.fingerprint === fingerprint) return cached.title;
    const title = readConversationTitle(dir, saved);
    labels.set(dir, { fingerprint, title });
    try {
      return await title;
    } catch (cause) {
      if (labels.get(dir)?.title === title) labels.delete(dir);
      throw cause;
    }
  };
  return async (
    listing: Discovery,
    query: URLSearchParams,
  ): Promise<ConversationPage | { readonly error: "invalid-pagination" }> => {
    const limitText = query.get("limit") ?? "50";
    if (!/^\d+$/.test(limitText)) return { error: "invalid-pagination" };
    const limit = Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return { error: "invalid-pagination" };
    let after = "";
    const cursor = query.get("cursor");
    if (cursor !== null) {
      try {
        if (cursor.length > 4096) return { error: "invalid-pagination" };
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
          !value ||
          typeof value !== "object" ||
          !("v" in value) ||
          value.v !== 1 ||
          !("after" in value) ||
          typeof value.after !== "string" ||
          value.after.length > 2048 ||
          !/^r:/.test(value.after)
        )
          return { error: "invalid-pagination" };
        after = value.after;
      } catch {
        return { error: "invalid-pagination" };
      }
    }
    const entries: Entry[] = [
      ...listing.records.map((record) => ({ key: `r:${record.conversationId}`, record })),
    ]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .filter((entry) => entry.key > after);
    const selected = entries.slice(0, limit);
    const present = new Set(listing.records.map((record) => record.dir));
    for (const dir of labels.keys()) if (!present.has(dir)) labels.delete(dir);
    const errors: DiscoveryIssue[] = [...listing.errors.slice(0, 100)];
    const conversations: ListedConversation[] = [];
    for (let offset = 0; offset < selected.length; offset += 4) {
      const results = await Promise.all(
        selected
          .slice(offset, offset + 4)
          .map(async (entry): Promise<ListedConversation | DiscoveryIssue> => {
            const { dir, conversationTitle: savedTitle, ...summary } = entry.record;
            try {
              return { ...summary, title: await label(dir, savedTitle) };
            } catch {
              return {
                code: "E-HUB-01",
                reason: "unreadable",
                conversationId: summary.conversationId,
                message: "Conversation content is unavailable or invalid",
              };
            }
          }),
      );
      for (const result of results) {
        if ("code" in result) errors.push(result);
        else conversations.push(result);
      }
    }
    const last = selected.at(-1);
    return {
      conversations,
      errors,
      errorCount: listing.errors.length + errors.length - Math.min(listing.errors.length, 100),
      nextCursor:
        entries.length > limit && last
          ? Buffer.from(JSON.stringify({ after: last.key, v: 1 })).toString("base64url")
          : null,
    };
  };
};
