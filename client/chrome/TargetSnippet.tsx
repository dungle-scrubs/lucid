import type { Anchor } from "../../src/anchors/anchor.ts";
import { targetText } from "./anchor-text.ts";

/**
 * How the chrome SHOWS what the human pointed at - the treatment the panel and
 * the transcript both render. What the excerpt says is `anchorText`'s, through
 * `anchor-text.ts`.
 */

/** The marked-text treatment: a translucent brass wash, no rule - the same
 *  language the surface uses for the mark itself. */
export const TargetSnippet = ({ target }: { readonly target: Anchor }) => {
  const text = targetText(target);
  return (
    // No `title`: the full text as a native tooltip was a wall of run-together
    // prose on anything larger than a phrase, and it fired on every pass of the
    // pointer over the card. The mark on the surface is the real referent - this
    // is a two-line reminder of what was pointed at, not a way to read it.
    <div className="bg-brass-400/10 px-2 py-1.5 text-[12px] leading-[1.45] text-cream-200">
      <span className="line-clamp-2">{text}</span>
    </div>
  );
};
