import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DOMParser,
  Element as LinkedomElement,
  HTMLScriptElement as LinkedomHTMLScriptElement,
  parseHTML,
} from "linkedom";
import { swapArtifactBody } from "../client/overlay/artifact-swap.ts";
import type { TrustedOverlaySwapCapabilities } from "../client/overlay/trusted-overlay.ts";

/**
 * swapArtifactBody under linkedom: the trusted-operations seam (DF-3).
 *
 * The swap must run node import and head-style mutation through the supplied
 * `operations` when present (captured pre-artifact, so a hostile artifact that
 * patches `Document.prototype.importNode` or the head accessors cannot observe
 * or redirect them), and fall back to the realm's own intrinsics when absent so
 * a swap driven without a capability bag behaves exactly as before.
 *
 * linkedom stands in for the untrusted realm's document. The swap module is
 * browser-targeted (it references the global `DOMParser`/`Element`/
 * `HTMLScriptElement`), so this file pins linkedom's constructors onto the
 * global scope for its own lifetime and restores them in afterAll. The strict
 * no-interception property (a patched `Document.prototype.importNode` / head
 * accessor cannot observe the swap because the real captured bag is the entry
 * point) is proven by the e2e hostile fixture; here we prove the bag is the
 * entry point by recording its calls.
 */

const g = globalThis as Record<string, unknown>;
const savedDOMParser = g.DOMParser;
const savedElement = g.Element;
const savedHTMLScriptElement = g.HTMLScriptElement;

beforeAll(() => {
  g.DOMParser = DOMParser;
  g.Element = LinkedomElement;
  g.HTMLScriptElement = LinkedomHTMLScriptElement;
});

afterAll(() => {
  if (savedDOMParser === undefined) delete g.DOMParser;
  else g.DOMParser = savedDOMParser;
  if (savedElement === undefined) delete g.Element;
  else g.Element = savedElement;
  if (savedHTMLScriptElement === undefined) delete g.HTMLScriptElement;
  else g.HTMLScriptElement = savedHTMLScriptElement;
});

const DOC = "<!doctype html><html><head></head><body><p data-lucid-id='old'>old</p></body></html>";
const NEXT =
  "<!doctype html><html><head><style>.a{color:red}</style></head><body><p data-lucid-id='new'>new</p></body></html>";

describe("swapArtifactBody without trusted operations (realm fallback)", () => {
  test("swaps the body and tags the head styles through the realm's own intrinsics", () => {
    const { document } = parseHTML(DOC);
    swapArtifactBody(document, NEXT, { keep: new Set(), ref: null });
    expect(document.querySelector("[data-lucid-id='new']")).toBeTruthy();
    expect(document.querySelector("[data-lucid-id='old']")).toBeFalsy();
    expect(document.head.querySelector("style[data-lucid-artifact-style]")).toBeTruthy();
  });

  test("a second swap removes the previously tagged styles, not just appends", () => {
    const { document } = parseHTML(DOC);
    swapArtifactBody(document, NEXT, { keep: new Set(), ref: null });
    swapArtifactBody(document, NEXT, { keep: new Set(), ref: null });
    expect(document.head.querySelectorAll("style[data-lucid-artifact-style]")).toHaveLength(1);
  });
});

describe("swapArtifactBody with trusted operations (DF-3)", () => {
  /** A recording bag: counts every call. importNode does the work via the
   *  realm so the body lands; removeArtifactStyles / appendArtifactStyle are
   *  pure counters - proving the swap delegates the head mutation to the bag
   *  rather than touching the realm head itself. */
  const recordingOps = (
    document: Document,
  ): { ops: TrustedOverlaySwapCapabilities; calls: Record<string, number> } => {
    const calls = { importNode: 0, removeArtifactStyles: 0, appendArtifactStyle: 0 };
    return {
      calls,
      ops: {
        importNode: (node, deep) => {
          calls.importNode += 1;
          return document.importNode(node, deep);
        },
        removeArtifactStyles: () => {
          calls.removeArtifactStyles += 1;
        },
        appendArtifactStyle: () => {
          calls.appendArtifactStyle += 1;
        },
      },
    };
  };

  test("node import and head mutation go through the supplied operations", () => {
    const { document } = parseHTML(DOC);
    const { ops, calls } = recordingOps(document);
    swapArtifactBody(document, NEXT, { keep: new Set(), ref: null, operations: ops });
    expect(calls.importNode).toBe(1);
    expect(calls.removeArtifactStyles).toBe(1);
    expect(calls.appendArtifactStyle).toBe(1);
    // The body import landed; the head did NOT, because the bag's
    // appendArtifactStyle is a pure counter here - which is the point.
    expect(document.querySelector("[data-lucid-id='new']")).toBeTruthy();
    expect(document.head.querySelector("style[data-lucid-artifact-style]")).toBeFalsy();
  });

  test("the realm head is not touched when operations are supplied", () => {
    // The security property at the unit tier: with the bag supplied, the swap
    // does NOT call the realm head's querySelectorAll/appendChild for the
    // style sync, so a hostile patch on those is never reached. (The
    // importNode entry point is asserted by the call counter above; the
    // captured-intrinsic version is the e2e fixture's job.)
    const { document } = parseHTML(DOC);
    let realmHeadTouches = 0;
    const head = document.head;
    const realQuery = head.querySelectorAll.bind(head);
    const realAppend = head.appendChild.bind(head);
    head.querySelectorAll = ((sel: string) => {
      realmHeadTouches += 1;
      return realQuery(sel);
    }) as typeof head.querySelectorAll;
    head.appendChild = ((node: Node) => {
      realmHeadTouches += 1;
      return realAppend(node);
    }) as typeof head.appendChild;
    const { ops } = recordingOps(document);
    swapArtifactBody(document, NEXT, { keep: new Set(), ref: null, operations: ops });
    expect(realmHeadTouches).toBe(0);
  });
});
