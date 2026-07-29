/**
 * Serve-time overlay injection (RFC §4, D-042, D-067). Response-transform that
 * injects the overlay bootstrap into the served iframe document WITHOUT
 * mutating the saved artifact file. The overlay mounts once into a persistent
 * host (`#__lucid_overlay_root`) that lives outside the artifact subtree, so a
 * subtree-only live-reload preserves it.
 */

import { closeIndexOf } from "../core/html-scan.ts";

/** The bootstrap markup, addressed at the session's own mount: `base` is ""
 *  on a dedicated server and "/s/<id>" under the daemon - an absolute
 *  `/__lucid/client.js` would 404 against the daemon's root. */
const overlayMarkup = (base: string): string => `
<div id="__lucid_overlay_root" data-lucid-ignore="true"></div>
<script>window.__LUCID__={mode:"overlay"};</script>
<script type="module" src="${base}/__lucid/client.js"></script>
`;

/** The source index of the true `</body>`, or -1 when the document has none. */
export const bodyCloseIndex = (html: string): number => closeIndexOf(html, "body");

/** Inject the overlay bootstrap into an artifact HTML document. */
export const injectOverlay = (artifactHtml: string, base = ""): string => {
  const markup = overlayMarkup(base);
  const spliceAt = (idx: number): string =>
    artifactHtml.slice(0, idx) + markup + artifactHtml.slice(idx);
  const body = bodyCloseIndex(artifactHtml);
  if (body !== -1) return spliceAt(body);
  const htmlClose = closeIndexOf(artifactHtml, "html");
  if (htmlClose !== -1) return spliceAt(htmlClose);
  return artifactHtml + markup;
};
