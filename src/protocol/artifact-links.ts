import type { DefaultTreeAdapterTypes } from "parse5";
import { parse } from "parse5";

export interface ArtifactLinkRefusal {
  readonly issue: "artifact-link-invalid" | "artifact-link-broken" | "artifact-link-unverified";
  readonly message: string;
  readonly verdict: "refused";
}

export function linkRefusal(
  issue: ArtifactLinkRefusal["issue"],
  url: string,
  reason: string,
): ArtifactLinkRefusal {
  return {
    issue,
    message: `Link ${JSON.stringify(url.slice(0, 240))}: ${reason}. Correct or remove the link and emit again. No version was stored.`,
    verdict: "refused",
  };
}

/** Inert parsing only. A link check cannot execute the document it validates. */
export function artifactLinks(
  bytes: string,
): { readonly urls: readonly string[] } | ArtifactLinkRefusal {
  const destinations = new Map<string, Set<DefaultTreeAdapterTypes.Element>>();
  const links: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ("attrs" in node) {
      const attribute = (name: string): string | undefined =>
        node.attrs.find((attr) => attr.name === name && !attr.namespace)?.value;
      const id = attribute("id");
      const name = node.tagName === "a" ? attribute("name") : undefined;
      for (const target of new Set([id, name])) {
        if (target === undefined) continue;
        const elements = destinations.get(target) ?? new Set();
        elements.add(node);
        destinations.set(target, elements);
      }
      if (node.tagName === "a" || node.tagName === "area") {
        const href = attribute("href");
        if (href !== undefined) links.push(href.trim());
      }
    }
    // parse5 stores inert template children in .content, not .childNodes.
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(bytes));
  const urls = new Set<string>();
  for (const href of links) {
    if (href.startsWith("#")) {
      let target: string;
      try {
        target = decodeURIComponent(href.slice(1));
      } catch {
        return linkRefusal("artifact-link-invalid", href, "invalid fragment encoding");
      }
      if (target === "" || (target.toLowerCase() === "top" && !destinations.has(target))) continue;
      const count = destinations.get(target)?.size ?? 0;
      if (count !== 1)
        return linkRefusal(
          "artifact-link-invalid",
          href,
          count === 0 ? "section target is missing" : "section target is ambiguous",
        );
      continue;
    }
    if (/^(mailto:|tel:)/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return linkRefusal(
        "artifact-link-invalid",
        href,
        "use an absolute HTTP(S) URL or a local #section",
      );
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      return linkRefusal(
        "artifact-link-invalid",
        href,
        "only credential-free HTTP(S), mailto, tel, and #section links are supported",
      );
    }
    url.hash = "";
    urls.add(url.href);
    if (urls.size > 100)
      return linkRefusal(
        "artifact-link-invalid",
        href,
        "the document exceeds 100 distinct web links",
      );
  }
  return { urls: [...urls] };
}
