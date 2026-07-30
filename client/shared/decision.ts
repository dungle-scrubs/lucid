/**
 * Decision points: an element the agent wants confirmed or refused.
 *
 * The artifact declares them in its own markup, because the agent is the party
 * that knows which of its recommendations needs a human's yes or no:
 *
 *     <li data-lucid-id="rec-1" data-lucid-decision>
 *       Adopt Prism over per-provider clients.
 *     </li>
 *
 * Two rules, both about nesting - a recommendation contains other pickable
 * things, and its boundary is not visible until the overlay draws it:
 *
 * 1. Everything INSIDE a marked element offers the options too, so landing on
 *    a phrase or a child still lets you decide.
 * 2. Choosing an option answers the DECISION, not the child that was picked -
 *    "Agree" recorded against a code span inside a recommendation is not what
 *    anyone meant, and the note the agent reads would point at the wrong
 *    thing. A typed note still annotates exactly what was picked.
 *
 * Shared, not chrome-only: the ancestor walk needs the live DOM, which exists
 * in the overlay (inside the artifact) and not in the chrome.
 */

/** The marker, as an attribute name. Boolean: present or absent, no value -
 *  Lucid owns the copy so every decision reads the same way everywhere. */
export const DECISION_ATTR = "data-lucid-decision";

/** What the chips say. Present tense: the human is doing this now, not
 *  reporting that they did it. */
export const DECISION_REPLIES = ["Agree", "Decline"] as const;

export type DecisionReply = (typeof DECISION_REPLIES)[number];

/** The minimum an element must offer to be walked. Structural typing so this
 *  works against a real DOM and against linkedom in tests. */
interface WalkableElement {
  hasAttribute(name: string): boolean;
  readonly parentElement: WalkableElement | null;
}

/**
 * The marked item a pick belongs to: the element itself if it is marked, else
 * its nearest marked ancestor, else null.
 *
 * NEAREST, so a recommendation inside a recommendation resolves to the inner
 * one - that is the thing the human pointed at.
 */
export const decisionAncestor = <T extends WalkableElement>(el: T | null): T | null => {
  for (let node: T | null = el; node !== null; node = node.parentElement as T | null) {
    if (node.hasAttribute(DECISION_ATTR)) return node;
  }
  return null;
};
