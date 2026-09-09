import { parse } from "parse5";

// Width and appearance read the same version during one render. Retain only
// the latest bytes and head values, never the much larger parsed document.
let latest:
  | { readonly bytes: string; readonly values: ReadonlyMap<string, string | null> }
  | undefined;

/** Read the first direct head declaration without browser DOM or resource loads. */
export function artifactMetadata(bytes: string, name: string): string | null {
  if (latest?.bytes === bytes) return latest.values.get(name) ?? null;
  const values = new Map<string, string | null>();
  const tree = parse(bytes);
  const html = tree.childNodes.find((node) => node.nodeName === "html");
  const head =
    html && "childNodes" in html
      ? html.childNodes.find((node) => node.nodeName === "head")
      : undefined;
  if (head && "childNodes" in head) {
    for (const node of head.childNodes) {
      if (node.nodeName !== "meta" || !("attrs" in node)) continue;
      const key = node.attrs.find((attr) => attr.name === "name")?.value;
      if (key !== undefined && !values.has(key)) {
        values.set(key, node.attrs.find((attr) => attr.name === "content")?.value ?? null);
      }
    }
  }
  latest = { bytes, values };
  return values.get(name) ?? null;
}
