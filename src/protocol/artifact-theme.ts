import type { DefaultTreeAdapterTypes } from "parse5";
import { parse } from "parse5";
import { HubError } from "./hub-errors.js";

/**
 * Inert head-meta reader for artifact bytes. The publish path uses this
 * instead of the browser copy so one strict parse serves both sides; the
 * shared theme vectors keep them from drifting.
 */
export function readHeadMeta(bytes: string, name: string): string | null {
  let tree: DefaultTreeAdapterTypes.Document;
  try {
    tree = parse(bytes);
  } catch {
    return null;
  }
  const html = tree.childNodes.find((node) => node.nodeName === "html");
  const head =
    html && "childNodes" in html
      ? html.childNodes.find((node) => node.nodeName === "head")
      : undefined;
  if (!head || !("childNodes" in head)) return null;
  for (const node of head.childNodes) {
    if (node.nodeName !== "meta" || !("attrs" in node)) continue;
    // Attribute names are case-insensitive in HTML; parse5 lowercases them.
    if (node.attrs.find((attr) => attr.name === "name")?.value !== name) continue;
    return node.attrs.find((attr) => attr.name === "content")?.value ?? null;
  }
  return null;
}

export type DeclaredTheme = "adaptive" | "light" | "dark" | "unmanaged";

/** The reader's classification: first head match, trimmed ASCII
 * whitespace, lowercase only, head only, inert parse. */
export function declaredTheme(bytes: string): DeclaredTheme {
  const value = readHeadMeta(bytes, "lucid-theme")?.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  return value === "light" || value === "dark" || value === "adaptive" ? value : "unmanaged";
}

/** Refuse unmanaged bytes with the fix named. Stores nothing by itself;
 * callers close what they opened before calling. */
export function refuseUnmanaged(): never {
  throw new HubError(
    'This document declares no lucid-theme and would render unmanaged. Add <meta name="lucid-theme" content="adaptive"> with matching color-scheme metadata, or resubmit with "theme": "unmanaged".',
    "E-HUB-09",
    400,
    ["Add the lucid-theme declaration"],
  );
}
