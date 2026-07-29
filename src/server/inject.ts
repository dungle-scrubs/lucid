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
const overlayMarkup = (base: string, nonce?: string, origin?: string): string => {
  const attr = nonce === undefined ? "" : ` nonce="${nonce}"`;
  // The nonce is NOT published on the global: an artifact script could read
  // it and mint its own <script nonce> - an 'unsafe-inline' the author never
  // granted. Only the markup carries it, and the overlay's own styles are
  // constructed stylesheets, which style-src does not govern at all.
  const boot = `window.__LUCID__={mode:"overlay"};`;
  // ORIGIN-absolute when the server knows how it was addressed (plan 04,
  // M2.3, #45): a path-absolute src resolves against the document base, so a
  // foreign `<base href>` re-rooted the bootstrap to a hostile origin. A full
  // origin is immune to `<base>`, and the element nonce (CSP path) authorizes
  // the element regardless of its source list.
  return `
<div id="__lucid_overlay_root" data-lucid-ignore="true"></div>
<script${attr}>${boot}</script>
<script type="module"${attr} src="${origin ?? ""}${base}/__lucid/client.js"></script>
`;
};

/** The source index of the true `</body>`, or -1 when the document has none. */
export const bodyCloseIndex = (html: string): number => closeIndexOf(html, "body");

/** Inject the overlay bootstrap into an artifact HTML document. */
export const injectOverlay = (
  artifactHtml: string,
  base = "",
  nonce?: string,
  origin?: string,
): string => {
  const markup = overlayMarkup(base, nonce, origin);
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
/** `content="…"` as its OWN attribute: a boundary before the name, so a
 *  `data-content="decoy"` never stands in for the policy. */
const CONTENT_ATTR = /(?:^|[\s"'/])content\s*=\s*("([^"]*)"|'([^']*)')/i;

/** The named character references a policy can plausibly arrive escaped in
 *  (an escaper that ran over the attribute value). The browser decodes before
 *  parsing the policy, so the lift must too. */
const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");

const findCspMetas = (html: string): CspMeta[] => {
  if (!/content-security-policy/i.test(html)) return []; // the common fast path
  const mask = maskHiddenText(html);
  const metas: CspMeta[] = [];
  for (const m of html.matchAll(CSP_META)) {
    // Real markup only: a CSP meta quoted inside a comment, a textarea, or an
    // attribute value is text, and the mask has blanked it there. Case-
    // insensitively - `<META>` is ordinary hand-written HTML, and a
    // case-sensitive check here left the meta in the document and the
    // bootstrap blocked (the exact defect this closes).
    if (!/^<meta/i.test(mask.slice(m.index, m.index + 5))) continue;
    const content = CONTENT_ATTR.exec(m[0]);
    const raw = content?.[2] ?? content?.[3];
    if (raw === undefined) continue;
    // Newlines are legal in the attribute and illegal in a header value.
    const policy = decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (policy !== "") metas.push({ start: m.index, end: m.index + m[0].length, policy });
  }
  return metas;
};

/** Directives a `<meta>` policy is REQUIRED to ignore (CSP3 §3.3): lifting
 *  them into a real header would turn them on for the first time. `report-uri`
 *  is the sharp one - it is a network egress the document declared inert, and
 *  a violation report carries the document URI and a sample. `frame-ancestors`
 *  and `sandbox` would blank or de-script the viewer's own iframe. */
const META_IGNORED = new Set(["report-uri", "report-to", "frame-ancestors", "sandbox"]);

/** The directive that actually governs an ELEMENT of this kind: the `-elem`
 *  form takes precedence over the plain one when present. */
const governingDirective = (parts: readonly string[], kind: "script" | "style"): string =>
  parts.some((p) => p.toLowerCase().startsWith(`${kind}-src-elem`))
    ? `${kind}-src-elem`
    : `${kind}-src`;

interface Granted {
  readonly policy: string;
  /** A nonce was added, so the bootstrap markup must carry it. */
  readonly nonce: boolean;
}

/**
 * Permit Lucid's bootstrap under one policy, changing as little as possible.
 *
 * The rule that makes this safe: a nonce-source in a list makes the browser
 * IGNORE `'unsafe-inline'` (CSP3 §6.7.3.2). An artifact that granted itself
 * `'unsafe-inline'` is relying on it - self-contained artifacts are inline
 * `<style>` and inline `<script>` by construction - so a nonce there would
 * silently strip the page's own styling and scripts. In that case the inline
 * bootstrap is ALREADY permitted, and only the module element needs a source:
 * the serving ORIGIN, added without touching anything else.
 */
const grantBootstrap = (policy: string, origin: string, nonce: string): Granted => {
  const parts = policy
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !META_IGNORED.has(p.split(/\s+/)[0]?.toLowerCase() ?? ""));
  const directive = governingDirective(parts, "script");
  const at = parts.findIndex((p) => {
    const name = p.split(/\s+/)[0]?.toLowerCase();
    return name === directive;
  });
  // Nothing constrains scripts (no directive AND no default-src): the
  // bootstrap already runs; leave the policy exactly as written.
  const dflt = parts.find((p) => (p.split(/\s+/)[0]?.toLowerCase() ?? "") === "default-src");
  if (at === -1 && dflt === undefined) return { policy: parts.join("; "), nonce: false };

  const existing = at === -1 ? (dflt as string) : (parts[at] as string);
  const sources = existing
    .split(/\s+/)
    .slice(1)
    .filter((src) => src.toLowerCase() !== "'none'");
  const keepsInline = sources.some((src) => src.toLowerCase() === "'unsafe-inline'");
  const granted = keepsInline ? [...sources, origin] : [...sources, `'nonce-${nonce}'`];
  const rebuilt = [directive, ...granted].join(" ");
  if (at === -1) parts.push(rebuilt);
  else parts[at] = rebuilt;
  return { policy: parts.join("; "), nonce: !keepsInline };
};

export interface InjectedDocument {
  readonly body: string;
  /** Extra response headers: the lifted CSP, when the document declared one. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The one injection path both servers share (#42, D-005).
 *
 * A document-authored CSP meta and an injected bootstrap cannot coexist as-is:
 * header and meta policies INTERSECT, so the meta blocks the injected module
 * no matter what a header allows. The meta is therefore LIFTED into the
 * response header - minus the directives a meta is required to ignore, so the
 * lift never turns on something the document could not have meant - with the
 * script directive granting the bootstrap the narrowest thing that works: the
 * serving origin when the author kept `'unsafe-inline'` (so their own inline
 * content keeps working), a nonce otherwise. Styles are not touched at all:
 * the overlay adopts constructed stylesheets, which `style-src` does not
 * govern. No meta, no header: an unrestricted artifact stays unrestricted.
 */
export const renderInjected = (artifactHtml: string, base = "", origin = ""): InjectedDocument => {
  const metas = findCspMetas(artifactHtml);
  if (metas.length === 0) {
    return { body: injectOverlay(artifactHtml, base, undefined, origin), headers: {} };
  }
  const nonce = randomUUID().replace(/-/g, "");
  let stripped = artifactHtml;
  for (const m of [...metas].sort((a, b) => b.start - a.start)) {
    stripped = stripped.slice(0, m.start) + stripped.slice(m.end);
  }
  const granted = metas.map((m) => grantBootstrap(m.policy, origin || "'self'", nonce));
  // Comma-joined is the field-combining form: several policies all enforce,
  // exactly as several metas did.
  const lifted = granted.map((g) => g.policy).join(", ");
  return {
    body: injectOverlay(stripped, base, granted.some((g) => g.nonce) ? nonce : undefined, origin),
    headers: { "content-security-policy": lifted },
  };
};
