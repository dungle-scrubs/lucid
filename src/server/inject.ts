/**
 * Serve-time overlay injection (RFC §4, D-042, D-067). Response-transform that
 * injects the overlay bootstrap into the served iframe document WITHOUT
 * mutating the saved artifact file. The overlay mounts once into a persistent
 * host (`#__lucid_overlay_root`) that lives outside the artifact subtree, so a
 * subtree-only live-reload preserves it.
 */

import { randomUUID } from "node:crypto";
import { closeIndexOf, maskHiddenText } from "../core/html-scan.ts";

/** The bootstrap markup, addressed at the session's own mount: `base` is ""
 *  on a dedicated server and "/s/<id>" under the daemon - an absolute
 *  `/__lucid/client.js` would 404 against the daemon's root. With a `nonce`
 *  (the CSP path, #42) both script elements carry it, and the overlay reads
 *  it off `window.__LUCID__` to stamp the styles it creates at runtime. */
const overlayMarkup = (base: string, nonce?: string): string => {
  const attr = nonce === undefined ? "" : ` nonce="${nonce}"`;
  const boot =
    nonce === undefined
      ? `window.__LUCID__={mode:"overlay"};`
      : `window.__LUCID__={mode:"overlay",nonce:"${nonce}"};`;
  return `
<div id="__lucid_overlay_root" data-lucid-ignore="true"></div>
<script${attr}>${boot}</script>
<script type="module"${attr} src="${base}/__lucid/client.js"></script>
`;
};

/** The source index of the true `</body>`, or -1 when the document has none. */
export const bodyCloseIndex = (html: string): number => closeIndexOf(html, "body");

/** Inject the overlay bootstrap into an artifact HTML document. */
export const injectOverlay = (artifactHtml: string, base = "", nonce?: string): string => {
  const markup = overlayMarkup(base, nonce);
  const spliceAt = (idx: number): string =>
    artifactHtml.slice(0, idx) + markup + artifactHtml.slice(idx);
  const body = bodyCloseIndex(artifactHtml);
  if (body !== -1) return spliceAt(body);
  const htmlClose = closeIndexOf(artifactHtml, "html");
  if (htmlClose !== -1) return spliceAt(htmlClose);
  return artifactHtml + markup;
};

/** A CSP meta in the VISIBLE source: its whole-tag span and its policy. */
interface CspMeta {
  readonly start: number;
  readonly end: number;
  readonly policy: string;
}

const CSP_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;

const findCspMetas = (html: string): CspMeta[] => {
  if (!/content-security-policy/i.test(html)) return []; // the common fast path
  const mask = maskHiddenText(html);
  const metas: CspMeta[] = [];
  for (const m of html.matchAll(CSP_META)) {
    // Real markup only: a CSP meta quoted inside a comment, a textarea, or an
    // attribute value is text, and the mask has blanked it there.
    if (!mask.startsWith("<meta", m.index)) continue;
    const content = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[0]);
    const policy = content?.[2] ?? content?.[3];
    if (policy !== undefined && policy.trim() !== "") {
      metas.push({ start: m.index, end: m.index + m[0].length, policy: policy.trim() });
    }
  }
  return metas;
};

/** Append a nonce source to one directive of one policy, deriving the
 *  directive from `default-src` when absent. `'none'` is dropped from the
 *  clone - it only has meaning alone, and the nonce now stands beside the
 *  document's real sources. A policy that does not constrain the directive
 *  (no directive AND no default-src) is left alone: unrestricted stays
 *  unrestricted. */
const allowNonce = (policy: string, directive: string, nonce: string): string => {
  const parts = policy
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const nonceSrc = `'nonce-${nonce}'`;
  const at = parts.findIndex(
    (p) => p.toLowerCase().startsWith(`${directive} `) || p.toLowerCase() === directive,
  );
  if (at !== -1) {
    const kept = (parts[at] as string)
      .split(/\s+/)
      .filter((s, i) => i === 0 || s.toLowerCase() !== "'none'");
    parts[at] = [...kept, nonceSrc].join(" ");
    return parts.join("; ");
  }
  const dflt = parts.find(
    (p) => p.toLowerCase().startsWith("default-src ") || p.toLowerCase() === "default-src",
  );
  if (dflt === undefined) return policy; // directive unrestricted; nothing to permit
  const sources = dflt
    .split(/\s+/)
    .slice(1)
    .filter((s) => s.toLowerCase() !== "'none'");
  parts.push([directive, ...sources, nonceSrc].join(" "));
  return parts.join("; ");
};

export interface InjectedDocument {
  readonly body: string;
  /** Extra response headers: the lifted CSP, when the document declared one. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The one injection path both servers share (#42, D-005). A document-authored
 * CSP meta and a bootstrap script cannot coexist as-is: header and meta
 * policies INTERSECT, so the meta would block the injected module no matter
 * what a header allowed. Instead the meta is LIFTED into the response header
 * with `script-src`/`style-src` each granted a fresh nonce, and the bootstrap
 * carries that nonce (the overlay stamps its runtime styles with it too). The
 * artifact's own scripts and styles stay governed exactly as it declared -
 * the nonce names only what Lucid injected. No meta, no header: an
 * unrestricted artifact stays unrestricted.
 */
export const renderInjected = (artifactHtml: string, base = ""): InjectedDocument => {
  const metas = findCspMetas(artifactHtml);
  if (metas.length === 0) {
    return { body: injectOverlay(artifactHtml, base), headers: {} };
  }
  const nonce = randomUUID().replace(/-/g, "");
  let stripped = artifactHtml;
  for (const m of [...metas].sort((a, b) => b.start - a.start)) {
    stripped = stripped.slice(0, m.start) + stripped.slice(m.end);
  }
  const lifted = metas
    .map((m) => allowNonce(allowNonce(m.policy, "script-src", nonce), "style-src", nonce))
    .join(", ");
  return {
    body: injectOverlay(stripped, base, nonce),
    headers: { "content-security-policy": lifted },
  };
};
