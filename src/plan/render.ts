import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parseHTML } from "linkedom";
import { marked } from "marked";
import { ARTIFACT_DIR, canonicalArtifactPath, projectRootOf } from "../core/paths.ts";

/**
 * Planner -> Lucid bridge (render half). Turns a planner living document
 * (markdown with `<!-- D-NNN -->` decision markers) into an addressable Lucid
 * artifact: every decided claim becomes `data-lucid-id="D-NNN"` (the planner's
 * ledger address IS Lucid's anchor), and the Open Questions section becomes
 * addressable `Q-N` items the human can answer in place. Styled with the Lucid
 * design system.
 */

export interface RenderOptions {
  readonly title?: string;
  readonly stage?: string;
  /** The doc this was rendered FROM, recorded in the page so a later render
   *  can tell "the same doc again" from "a different doc, same name". */
  readonly source?: string;
}

/** The meta name carrying {@link RenderOptions.source}. */
export const SOURCE_META = "lucid:plan-source";

/**
 * The doc an existing artifact was rendered from, or null when it carries no
 * stamp (rendered before this existed, or not a rendered plan at all).
 *
 * Read with a regex rather than a DOM parse: this runs on a file that may be
 * anything at all, and the only question is whether it declares a source.
 */
export const renderedSourceOf = (html: string): string | null => {
  // Bounded to the HEAD: the stamp is written there, and scanning the whole
  // document would let a `<meta>` in the body of an UNSTAMPED page (one
  // rendered before the stamp existed) answer for it.
  const head = html.slice(0, html.search(/<\/head>/i) + 1 || html.length);
  const match = new RegExp(`<meta name="${SOURCE_META}" content="([^"]*)"`).exec(head);
  if (match?.[1] === undefined) return null;
  // `&amp;` LAST, or a path containing the literal text `&quot;` decodes to a
  // quote it never had - and `&lt;` was escaped on the way in and never
  // unescaped, so a path containing `<` could not match its own stamp and the
  // doc could never re-render its own artifact without --force.
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
};

/**
 * Where `lucid plan render <doc>` puts its artifact: the `--out` path when one
 * is given, otherwise the doc's own name with a trailing `.md` traded for
 * `.lucid.html`.
 *
 * Always absolute. The derived path is printed back as `lucid open <path>`, and
 * a relative one resolves against whatever directory the NEXT process happens to
 * start in - which for an agent handing the path to a fresh shell is rarely the
 * one the render ran in.
 *
 * The `$` anchor is load-bearing: an unanchored `.md` would eat the first match
 * anywhere in the path, so a doc under a folder named `notes.md/` would be
 * written somewhere that does not exist.
 *
 * Owns the derivation only - reading the doc, rendering it and writing the file
 * stay with the CLI handler.
 *
 * The default lands in the project's artifact folder, NOT beside the markdown
 * (plan 05, M3.2): the rendered page is an artifact, `open` refuses artifacts
 * outside `.lucid/`, and this function prints the very `lucid open <path>` the
 * human runs next. A doc outside any project keeps the beside-the-markdown
 * derivation - there is no artifact folder to put it in. An explicit `--out`
 * is always honoured; a human naming a path is not guessing.
 */
export const planArtifactPath = (doc: string, out?: string): string => {
  if (out !== undefined) return resolve(out);
  // Realpath'd, like every other identity surface (plan 05, M1.1): a symlink
  // and its target are ONE document, and deriving two artifact paths from them
  // would mint two review sessions for one file.
  const docPath = canonicalArtifactPath(doc);
  const stem = basename(docPath).replace(/\.md$/i, "");
  const root = projectRootOf(dirname(docPath));
  if (root === null) return resolve(dirname(docPath), `${stem}.lucid.html`);
  return resolve(
    root,
    ARTIFACT_DIR,
    `${flatName(relative(root, dirname(docPath)), stem)}.lucid.html`,
  );
};

/**
 * A name unique across the project, because the artifact folder is FLAT.
 *
 * Every plan lives in its own folder and each carries an `implementation.md`,
 * so rendering into one `.lucid/` collapses six documents onto one path. A
 * collision here is silent in the worst way: the overwrite keeps the basename,
 * so the stem-collision guard sees its own owner, and the next `lucid open`
 * mints a new VERSION inside the first document's session.
 *
 * Three hand-rolled reversible encodings were tried and all three were broken
 * by inputs nobody had written down - doubling (`a-/a` and `a/-a` both spell
 * `a---a`), a `dot-` marker (identical to a directory named `dot`), and
 * splitting on a backslash (an ordinary POSIX filename character). The fourth
 * was correct and unusable: it produced names beginning with `-`, which every
 * CLI tool reads as a flag.
 *
 * So the name stops trying to be reversible. A READABLE slug carries the path
 * for a human reading `.lucid/`, and a digest over the canonical (segments,
 * stem) pair carries uniqueness. The slug may be as lossy as it likes. And
 * `runPlanRender` refuses to overwrite an artifact rendered from a different
 * doc, so even a digest collision is a refusal rather than a silent merge -
 * which is what makes this the safe shape rather than the clever one.
 */
const DIGEST_HEX = 12;
const NAME_BUDGET_BYTES = 200;

/** Path segments, canonical: `a/./b`, `a//b` and `a/b` are one directory. */
const segmentsOf = (relDir: string): string[] =>
  relDir === "" || relDir === "."
    ? []
    : // `sep`, not a `[/\\]` class: a backslash is an ORDINARY filename
      // character on POSIX, so splitting on it made a single directory named
      // `a\b` and the nested pair `a/b` one name.
      relDir.split(sep).filter((s) => s !== "" && s !== ".");

/** Readable, filesystem-safe, and deliberately lossy - the digest carries
 *  uniqueness, so this only has to help a human recognise the file. */
const slugOf = (parts: readonly string[]): string =>
  parts
    .join("-")
    .replace(/^[.-]+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");

export const flatName = (relDir: string, stem: string): string => {
  const parts = [...segmentsOf(relDir), stem];
  // Keyed on the ARRAY, not on a joined string: a concatenation is itself
  // ambiguous over the pair it is meant to distinguish.
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, DIGEST_HEX);
  const slug = slugOf(parts);
  if (slug === "") return digest;

  const suffix = `-${digest}`;
  const room = NAME_BUDGET_BYTES - Buffer.byteLength(suffix, "utf8");
  // By CODE POINT: `slice` cut a surrogate pair in half and produced a lone
  // surrogate - a filename that is not valid UTF-8, in bytes meant to be
  // committed and read on another machine. Bytes and not UTF-16 units because
  // NAME_MAX is 255 BYTES on ext4, i.e. any Linux checkout of a record.
  let head = "";
  for (const ch of slug) {
    if (Buffer.byteLength(head + ch, "utf8") > room) break;
    head += ch;
  }
  return `${head}${suffix}`;
};

/** Attribute-safe: the source is a filesystem path and may hold either quote. */
const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const DECISION_RE = /^\s*D-\d+\s*$/;

/** Assign data-lucid-id to the claim governed by each `<!-- D-NNN -->` marker. */
const applyDecisionIds = (document: Document): void => {
  // Walk all comment nodes; linkedom exposes them via childNodes (nodeType 8).
  const comments: Comment[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) comments.push(child as Comment);
      else walk(child);
    }
  };
  walk(document.body);

  for (const comment of comments) {
    const text = comment.textContent ?? "";
    if (!DECISION_RE.test(text)) continue;
    const id = text.trim();
    // Block marker: id the next element sibling. Inline marker: id the parent.
    const next = comment.nextElementSibling;
    const target = next ?? (comment.parentElement as Element | null);
    if (target && target.tagName !== "BODY" && !target.getAttribute("data-lucid-id")) {
      target.setAttribute("data-lucid-id", id);
      target.setAttribute("data-lucid-decision", "true");
    }
    comment.remove();
  }
};

/**
 * Wrap each heading-delimited group in a padded `<section>` so a reviewer can
 * hover and annotate the whole group as a unit - the padding gives a
 * comfortable target band instead of the hairline gap between child lines.
 */
const groupIntoSections = (document: Document): void => {
  const body = document.body;
  const children = Array.from(body.children);
  if (children.length === 0) return;
  const collected: Element[] = [];
  let section: Element | null = null;
  for (const child of children) {
    if (child.tagName === "H1" || child.tagName === "H2" || section === null) {
      section = document.createElement("section");
      section.className = "plan-section";
      collected.push(section);
    }
    section.appendChild(child);
  }
  for (const s of collected) body.appendChild(s);
};

/** Turn the Open Questions section's items into addressable Q-N elements. */
const applyQuestionIds = (document: Document): void => {
  const headings = Array.from(document.querySelectorAll("h1,h2,h3"));
  const qHeading = headings.find((h) => /open questions|questions/i.test(h.textContent ?? ""));
  if (!qHeading) return;
  let n = 0;
  let node: Element | null = qHeading.nextElementSibling;
  while (node && !/^H[1-3]$/.test(node.tagName)) {
    if (node.tagName === "OL" || node.tagName === "UL") {
      for (const li of Array.from(node.children)) {
        n += 1;
        li.setAttribute("data-lucid-id", `Q-${n}`);
        li.setAttribute("data-lucid-question", "true");
      }
    }
    node = node.nextElementSibling;
  }
};

const STYLE = `
  /* Self-contained by doctrine: an artifact must render identically offline
     from disk, so system font stacks only - never a CDN import. */
  :root {
    --ink:#211d15; --soft:#4b4334; --surface:#faf6ec; --line:#e6dbc3; --brass:#bd9a4e; --brass-deep:#9f8038; --sage:#61714b; --amber:#c8862a;
    --code-bg:#efe8d8; --pre-bg:#0e0d0b; --pre-fg:#f2ecdc; --q-bg:rgba(200,134,42,0.08); --hover:rgba(189,154,78,0.05);
    --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
    --sans:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  }
  /* Dark mode follows the viewer's OS/browser theme - no toggle, no JS, so the
     artifact stays self-contained and renders identically offline. The paper
     goes dark but stays a *document*: a warm, lifted ground that reads as a
     sheet resting on the chrome, never the chrome's own near-black ground. Same
     accent, same type - only the ground and ink invert. */
  @media (prefers-color-scheme: dark) {
    :root {
      --ink:#ece3cf; --soft:#a89d84; --surface:#211d15; --line:rgba(236,227,207,0.14); --brass:#cba85a; --brass-deep:#d9bd7a; --sage:#97a67e; --amber:#e2a541;
      --code-bg:#2b2419; --pre-bg:#12100d; --pre-fg:#f2ecdc; --q-bg:rgba(226,165,65,0.13); --hover:rgba(203,168,90,0.09);
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--surface); color:var(--ink); font-family:var(--sans); font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased; }
  .doc { max-width:860px; margin:0 auto; padding:48px 24px 120px; }
  .plan-section { padding:14px 20px; margin:6px 0; transition:background .12s; }
  .plan-section:hover { background:var(--hover); }
  .plan-section > :first-child { margin-top:8px; }
  .eyebrow { font-size:12px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:var(--brass-deep); }
  h1,h2,h3 { font-family:var(--serif); font-weight:500; letter-spacing:-.01em; }
  h1 { font-style:italic; font-size:40px; line-height:1.1; margin:8px 0 16px; }
  h2 { font-size:26px; margin:36px 0 12px; }
  h3 { font-size:20px; margin:26px 0 8px; }
  p,li { margin:8px 0; }
  ul,ol { padding-left:22px; }
  code { font-family:var(--mono); font-size:.86em; background:var(--code-bg); padding:1px 5px; }
  pre { background:var(--pre-bg); color:var(--pre-fg); padding:14px 16px; overflow:auto; }
  pre code { background:none; padding:0; color:inherit; }
  blockquote { border-left:3px solid var(--brass); margin:12px 0; padding:4px 0 4px 16px; color:var(--soft); font-style:italic; }
  table { border-collapse:collapse; width:100%; margin:14px 0; font-size:14px; }
  th,td { border:1px solid var(--line); padding:7px 10px; text-align:left; }
  hr { border:0; border-top:1px solid var(--line); margin:32px 0; }
  [data-lucid-decision] { position:relative; }
  [data-lucid-question] {
    list-style:none; position:relative; margin-left:-8px; padding:8px 12px 8px 34px;
    background:var(--q-bg); border-left:3px solid var(--amber);
  }
  [data-lucid-question]::before { content:"?"; position:absolute; left:11px; top:8px; font-weight:700; color:var(--amber); }
  footer { margin-top:48px; color:var(--soft); font-size:13px; font-family:var(--serif); font-style:italic; }
`;

/** Render a planner markdown document to a Lucid artifact HTML string. */
export const renderPlanDoc = (markdown: string, options: RenderOptions = {}): string => {
  const bodyHtml = marked.parse(markdown, { async: false, gfm: true }) as string;
  const { document } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  applyDecisionIds(document as unknown as Document);
  applyQuestionIds(document as unknown as Document);
  groupIntoSections(document as unknown as Document);
  const inner = document.body.innerHTML;
  const title = options.title ?? "Plan review";
  const eyebrow = options.stage ? `Plan review · ${options.stage}` : "Plan review";
  const sourceStamp =
    options.source === undefined
      ? ""
      : `<meta name="${SOURCE_META}" content="${escapeAttr(options.source)}" />`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
${sourceStamp}<title>${title}</title>
<style>${STYLE}</style></head>
<body>
<main class="doc">
<div class="eyebrow">${eyebrow}</div>
${inner}
<footer>Mark up any decision, or answer a question, and it loops back to the plan ledger.</footer>
</main>
</body>
</html>`;
};
