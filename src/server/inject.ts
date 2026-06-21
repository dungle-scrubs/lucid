/**
 * Serve-time overlay injection (RFC §4, D-042, D-067). Response-transform that
 * injects the overlay bootstrap into the served iframe document WITHOUT
 * mutating the saved artifact file. The overlay mounts once into a persistent
 * host (`#__lucid_overlay_root`) that lives outside the artifact subtree, so a
 * subtree-only live-reload preserves it.
 */

const OVERLAY_MARKUP = `
<div id="__lucid_overlay_root" data-lucid-ignore="true"></div>
<script>window.__LUCID__={mode:"overlay"};</script>
<script type="module" src="/__lucid/client.js"></script>
`;

/** Inject the overlay bootstrap into an artifact HTML document. */
export const injectOverlay = (artifactHtml: string): string => {
  const closingBody = /<\/body\s*>/i;
  if (closingBody.test(artifactHtml)) {
    return artifactHtml.replace(closingBody, `${OVERLAY_MARKUP}</body>`);
  }
  const closingHtml = /<\/html\s*>/i;
  if (closingHtml.test(artifactHtml)) {
    return artifactHtml.replace(closingHtml, `${OVERLAY_MARKUP}</html>`);
  }
  return artifactHtml + OVERLAY_MARKUP;
};
