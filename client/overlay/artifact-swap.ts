/**
 * Swaps the artifact's body into the live document and syncs its head styles.
 *
 * OPERATES ON THE UNTRUSTED REALM'S DOCUMENT. The overlay lives in the
 * artifact iframe's own document and shares its JS realm, so this module must
 * never assume the document, the parsed html, or the nodes it carries are
 * benign. It takes the live document plus the replacement html and performs the
 * subtree swap, preserving the overlay-owned nodes the caller names - it cannot
 * discover them itself (D-028). Trusted handles for importNode/head access are
 * a deferred follow-up (DF-3); today this calls the realm's own intrinsics,
 * which is safe because it mutates only the artifact document, never the
 * chrome.
 */

export interface ArtifactSwapOptions {
  /** Nodes the overlay owns and must survive the body swap (its host + element).
   *  Client.js scripts are preserved automatically. */
  readonly keep: ReadonlySet<Node>;
  /** New artifact body nodes are inserted before this node (the overlay host),
   *  so the host stays at the end of the body. Null appends to the end. */
  readonly ref: Node | null;
  /** Invoked when a newly added linked stylesheet finishes loading, so a
   *  dark-capable artifact is not pinned light by an early capability check. */
  readonly onLinkedSheetLoad?: () => void;
}

export interface ArtifactSwapResult {
  /** data-lucid-id values present after the swap but not before. */
  readonly addedIds: ReadonlySet<string>;
}

const CLIENT_JS_SRC = "/__lucid/client.js";
const ARTIFACT_STYLE_ATTR = "data-lucid-artifact-style";

const collectSectionIds = (document: Document): Set<string> => {
  const ids = new Set<string>();
  for (const element of document.querySelectorAll("[data-lucid-id]")) {
    const id = element.getAttribute("data-lucid-id");
    if (id !== null && id !== "") ids.add(id);
  }
  return ids;
};

/**
 * Replace the document's artifact body with the parsed html, sync its head
 * `<style>`/`<link rel="stylesheet">` (tagged so a later swap removes them),
 * and report the newly present section ids. The overlay host, the overlay
 * element, and the chrome's client.js scripts are preserved; new nodes marked
 * `data-lucid-ignore="true"` or re-loading client.js are not inserted.
 */
export const swapArtifactBody = (
  document: Document,
  htmlText: string,
  options: ArtifactSwapOptions,
): ArtifactSwapResult => {
  const parsed = new DOMParser().parseFromString(htmlText, "text/html");
  const previousIds = collectSectionIds(document);

  const preserve = new Set(options.keep);
  for (const script of document.body.querySelectorAll(`script[src='${CLIENT_JS_SRC}']`)) {
    preserve.add(script);
  }
  for (const node of Array.from(document.body.childNodes)) {
    if (!preserve.has(node)) document.body.removeChild(node);
  }

  const ref = options.ref;
  for (const node of Array.from(parsed.body.childNodes)) {
    if (node instanceof Element && node.getAttribute("data-lucid-ignore") === "true") continue;
    if (node instanceof HTMLScriptElement && node.src.includes(CLIENT_JS_SRC)) continue;
    document.body.insertBefore(document.importNode(node, true), ref);
  }

  for (const sheet of document.head.querySelectorAll(`[${ARTIFACT_STYLE_ATTR}]`)) {
    sheet.remove();
  }
  for (const style of parsed.head.querySelectorAll("style")) {
    const clone = document.importNode(style, true);
    clone.setAttribute(ARTIFACT_STYLE_ATTR, "true");
    document.head.appendChild(clone);
  }
  for (const link of parsed.head.querySelectorAll('link[rel="stylesheet"]')) {
    const clone = document.importNode(link, true);
    clone.setAttribute(ARTIFACT_STYLE_ATTR, "true");
    if (options.onLinkedSheetLoad) {
      clone.addEventListener("load", () => options.onLinkedSheetLoad?.(), { once: true });
    }
    document.head.appendChild(clone);
  }

  const currentIds = collectSectionIds(document);
  return { addedIds: new Set([...currentIds].filter((id) => !previousIds.has(id))) };
};
