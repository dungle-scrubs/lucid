/**
 * Agent chat references, resolved in the browser against the version on
 * screen. A verbatim quote resolves to the leaf block holding its offset;
 * anything else goes to `resolveSpot` with selectors seeded from the quote
 * itself. Only a reference naming the version on screen is attempted.
 */
import type { ChatReference, ChatReferenceBlock } from "../../protocol/chat-references.js";
import { elementIds, resolveSpot } from "./anchor.js";

export interface ResolvedChatReference {
  readonly label: string;
  readonly quote: string;
  readonly elementId: string | null;
  readonly how: string | null;
}

/** Resolve one line's references against the document on screen.
 *
 * `docBytes` is the version on screen, `docVersion` its number. Only refs
 * naming that artifact and version are attempted; blocks for anything else
 * are omitted from the result and their labels render as prose. This is
 * current-document resolution, not verified-source re-anchoring: it trusts
 * the bytes the page shows, unlike the note walk, which checks the source
 * version hash before re-pointing anything. */
export const resolveChatReferences = (
  docBytes: string,
  docVersion: number,
  refs: readonly ChatReferenceBlock[],
  artifactId: string,
): readonly ResolvedChatReference[] => {
  const mine = refs.filter((b) => b.artifactId === artifactId && b.version === docVersion);
  if (mine.length === 0) return [];
  const parser = new DOMParser();
  const target = parser.parseFromString(docBytes, "text/html");
  if (target.body === null) return mine.flatMap((b) => b.refs.map(labelOnly));
  const all = elementIds(target);
  const whole = target.body.textContent ?? "";
  return mine.flatMap((b) =>
    b.refs.map((r) => {
      // Verbatim only when the words occur once; repeats fall through to
      // the approximate layer, which refuses ambiguity rather than
      // picking one.
      const at = whole.indexOf(r.quote);
      const repeated = at !== -1 && whole.indexOf(r.quote, at + r.quote.length) !== -1;
      if (at === -1 || repeated) {
        // Selectors seeded from the quote itself, not from an element
        // that no longer holds those words.
        const approx = resolveSpot(
          target,
          {
            quote: {
              exact: r.quote,
              prefix: "",
              suffix: "",
            },
            position: { start: -1, end: -1 },
            css: "body",
          },
          true,
        );
        if (!approx.resolved) return { label: r.label, quote: r.quote, elementId: null, how: null };
        return {
          label: r.label,
          quote: r.quote,
          elementId: approx.elementId,
          how: approx.how,
        };
      }
      // The text node holding the offset decides the owner. Walking text
      // nodes keeps this aligned with `whole`: summing leaf textContent
      // drifts wherever whitespace or non-leaf text sits between elements.
      let owner: Element | null = null;
      const walker = target.createTreeWalker(target.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let pos = 0;
      while (node !== null) {
        const len = node.nodeValue?.length ?? 0;
        if (at >= pos && at < pos + len) {
          const parent = (node as Text).parentElement;
          owner = parent !== null && all.includes(parent) ? parent : null;
          break;
        }
        pos += len;
        node = walker.nextNode();
      }
      if (owner === null) return { label: r.label, quote: r.quote, elementId: null, how: null };
      const idx = all.indexOf(owner);
      if (idx === -1) return { label: r.label, quote: r.quote, elementId: null, how: null };
      return {
        label: r.label,
        quote: r.quote,
        elementId: `e${idx + 1}`,
        how: "exact",
      };
    }),
  );
};

const labelOnly = (r: ChatReference): ResolvedChatReference => ({
  label: r.label,
  quote: r.quote,
  elementId: null,
  how: null,
});

/** Whether a chat reference click travels: never while an older version
 * is pinned. The target was resolved against what is on screen. */
export const chatLinkTravels = (pinnedOld: boolean): boolean => !pinnedOld;

export type ChatLabelPart =
  | { readonly kind: "text"; readonly text: string; readonly at: number }
  | { readonly kind: "label"; readonly label: string; readonly at: number };

/** Split stripped chat text on bracketed labels. Each part carries its
 * offset as the stable key. */
export const splitChatLabels = (text: string): readonly ChatLabelPart[] => {
  const out: ChatLabelPart[] = [];
  const re = /\[([^[\]]{1,120})\]/g;
  let at = 0;
  for (;;) {
    const m = re.exec(text);
    if (m === null) break;
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index), at });
    out.push({ kind: "label", label: m[1] as string, at: m.index });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at), at });
  return out;
};
