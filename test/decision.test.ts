import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { DECISION_ATTR, DECISION_REPLIES, decisionAncestor } from "../client/shared/decision.ts";

/**
 * Decision points (user request, 2026-07-30).
 *
 * An agent marks a recommended action it wants confirmed or refused, and the
 * composer offers one-tap Agree / Decline for it. Two rules the human asked
 * for, both about NESTING - a recommendation contains other pickable things,
 * and you cannot see where it starts:
 *
 * 1. Everything inside a marked element offers the options too. Picking a
 *    phrase or a child of the recommendation still lets you decide on it.
 * 2. Choosing an option answers the DECISION, not the child you happened to
 *    hit - the note goes up to the marked item. A typed note still annotates
 *    exactly what you picked, which is the point of picking it.
 */

const doc = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document;

describe("decisionAncestor: the marked item a pick belongs to", () => {
  test("the marked element itself", () => {
    const d = doc(`<li id="r" ${DECISION_ATTR}>Use Prism</li>`);
    expect((decisionAncestor(d.getElementById("r") as never) as { id: string } | null)?.id).toBe(
      "r",
    );
  });

  test("a child of it - everything inside offers the options (rule 1)", () => {
    const d = doc(`<li id="r" ${DECISION_ATTR}>Use <code id="c">Prism</code> here</li>`);
    expect((decisionAncestor(d.getElementById("c") as never) as { id: string } | null)?.id).toBe(
      "r",
    );
  });

  test("a deeply nested child, too", () => {
    const d = doc(`<li id="r" ${DECISION_ATTR}><p><span><em id="deep">why</em></span></p></li>`);
    expect((decisionAncestor(d.getElementById("deep") as never) as { id: string } | null)?.id).toBe(
      "r",
    );
  });

  test("an element outside any marked item has none", () => {
    const d = doc(`<p id="p">plain</p><li ${DECISION_ATTR}>Use Prism</li>`);
    expect(decisionAncestor(d.getElementById("p") as never)).toBeNull();
  });

  test("the NEAREST marked ancestor wins when they nest", () => {
    // A recommendation inside a recommendation: deciding on the inner one is
    // what the human pointed at.
    const d = doc(
      `<div id="outer" ${DECISION_ATTR}><li id="inner" ${DECISION_ATTR}><b id="t">x</b></li></div>`,
    );
    expect((decisionAncestor(d.getElementById("t") as never) as { id: string } | null)?.id).toBe(
      "inner",
    );
  });

  test("a lookalike attribute is not the marker", () => {
    const d = doc(`<li id="r" data-lucid-decisionish>x</li>`);
    expect(decisionAncestor(d.getElementById("r") as never)).toBeNull();
  });
});

describe("the chips say what the human is doing, in the present tense", () => {
  test("Agree and Decline", () => {
    expect(DECISION_REPLIES).toEqual(["Agree", "Decline"]);
  });
});
