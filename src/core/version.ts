import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** `sha256:<hex>` of a string, matching the form recorded in `version` events. */
export const hashContent = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

export interface StructureResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Container tags whose open/close counts must balance in a complete document. */
const BALANCED_TAGS = [
  "html",
  "head",
  "body",
  "main",
  "article",
  "section",
  "ul",
  "ol",
  "table",
  "thead",
  "tbody",
] as const;

const countOpen = (html: string, tag: string): number => {
  // <tag>, <tag ...>, but not self-closing <tag/> (none of BALANCED_TAGS self-close).
  const re = new RegExp(`<${tag}(?:\\s[^>]*?)?(?<!/)>`, "gi");
  return (html.match(re) ?? []).length;
};

const countClose = (html: string, tag: string): number => {
  const re = new RegExp(`</${tag}\\s*>`, "gi");
  return (html.match(re) ?? []).length;
};

/**
 * Structural HTML-completeness validation (D-061). HTML error-recovery never
 * reports truncation, so a tag-boundary-truncated file parses as "complete";
 * this checks for an actual closing root and balanced primary structure rather
 * than mere parseability. Heuristic but catches the realistic failure mode: a
 * watcher firing on a partially-flushed write.
 */
export const validateStructure = (html: string): StructureResult => {
  const trimmed = html.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty document" };
  if (!trimmed.includes("<")) return { ok: false, reason: "no markup" };
  if (!trimmed.endsWith(">")) {
    return { ok: false, reason: "document does not end on a closed tag (truncated mid-tag)" };
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes("<html") && !lower.includes("</html>")) {
    return { ok: false, reason: "missing </html>" };
  }
  if (lower.includes("<body") && !lower.includes("</body>")) {
    return { ok: false, reason: "missing </body>" };
  }

  for (const tag of BALANCED_TAGS) {
    const open = countOpen(trimmed, tag);
    const close = countClose(trimmed, tag);
    if (open !== close) {
      return {
        ok: false,
        reason: `unbalanced <${tag}> (${open} open, ${close} close)`,
      };
    }
  }
  return { ok: true };
};

/** Write a snapshot file durably (mkdir -p, write, fsync). */
export const writeSnapshot = (absPath: string, content: string): void => {
  mkdirSync(dirname(absPath), { recursive: true });
  const fd = openSync(absPath, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export type SnapshotStatus = "ok" | "missing" | "mismatch";

/** Verify a referenced snapshot exists and matches its recorded hash (D-024). */
export const verifySnapshot = async (
  absPath: string,
  expectedHash: string,
): Promise<SnapshotStatus> => {
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
  return hashContent(content) === expectedHash ? "ok" : "mismatch";
};
