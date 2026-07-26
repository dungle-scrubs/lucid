/**
 * Serve-time overlay injection (RFC §4, D-042, D-067). Response-transform that
 * injects the overlay bootstrap into the served iframe document WITHOUT
 * mutating the saved artifact file. The overlay mounts once into a persistent
 * host (`#__lucid_overlay_root`) that lives outside the artifact subtree, so a
 * subtree-only live-reload preserves it.
 */

/** The bootstrap markup, addressed at the session's own mount: `base` is ""
 *  on a dedicated server and "/s/<id>" under the daemon - an absolute
 *  `/__lucid/client.js` would 404 against the daemon's root. */
const overlayMarkup = (base: string): string => `
<div id="__lucid_overlay_root" data-lucid-ignore="true"></div>
<script>window.__LUCID__={mode:"overlay"};</script>
<script type="module" src="${base}/__lucid/client.js"></script>
`;

/** Inject the overlay bootstrap into an artifact HTML document. */
export const injectOverlay = (artifactHtml: string, base = ""): string => {
  const markup = overlayMarkup(base);
  const closingBody = /<\/body\s*>/i;
  if (closingBody.test(artifactHtml)) {
    return artifactHtml.replace(closingBody, `${markup}</body>`);
  }
  const closingHtml = /<\/html\s*>/i;
  if (closingHtml.test(artifactHtml)) {
    return artifactHtml.replace(closingHtml, `${markup}</html>`);
  }
  return artifactHtml + markup;
};
