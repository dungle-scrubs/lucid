// Reaching into the artifact surface, and waiting for it to settle.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones in Phase 5 add tests, never harness: an agent that needs to change
// something here has been scoped wrong, and the split is what makes that
// visible rather than a merge conflict nobody reads.

import type { FrameLocator, Locator, Page } from "@playwright/test";

/** The active session's artifact frame. `:visible` because every open tab's
 *  view stays mounted, so N iframes exist and only one is showing. */
export const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]:visible');

/**
 * Resolve once the visible overlay has drained everything the chrome sent it
 * before this call.
 *
 * The reason this exists: some chrome actions are asserted by their ABSENCE of
 * effect on the artifact - a theme the artifact declines, a highlight for an
 * anchor it cannot find. There is no state transition to await, so a polling
 * assertion resolves against the value that was already there and passes before
 * the overlay has even read the message. That is not a slow-machine problem; a
 * fast machine is precisely where it passes wrongly, which is how a laptop can
 * stay green on a claim CI disproves.
 *
 * So this posts a message of its own and waits for the answer. The overlay
 * services `ping` from the same synchronous `onMessage` switch that applies a
 * theme, and postMessage delivery to one window is ordered, so a `pong` proves
 * the action's message was handled first.
 *
 * `ping`/`pong` exists for exactly this and does nothing else. Borrowing a real
 * message would import its effect: `measure-content` looks inert and is not -
 * the chrome answers it by resizing the review panel AND writing the new width
 * to localStorage, so a probe named "settled" would quietly resize the surface
 * and change state that outlives the test. The nonce keeps a reply attributable
 * to the probe that asked for it, so a reply still in flight from an earlier
 * call cannot resolve this one early.
 */
export const overlaySettled = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const nonce = `settle-${Math.random().toString(36).slice(2)}`;
    const frame = Array.from(
      document.querySelectorAll<HTMLIFrameElement>('iframe[title="artifact surface"]'),
    ).find((el) => el.offsetParent !== null || el.getClientRects().length > 0);
    if (!frame?.contentWindow) throw new Error("no visible artifact surface to settle");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onReply);
        reject(new Error(`overlay did not answer ping ${nonce}`));
      }, 10_000);
      function onReply(e: MessageEvent): void {
        const d = e.data as { source?: string; type?: string; nonce?: string } | null;
        if (d?.source !== "lucid-overlay" || d.type !== "pong" || d.nonce !== nonce) return;
        clearTimeout(timer);
        window.removeEventListener("message", onReply);
        resolve();
      }
      window.addEventListener("message", onReply);
      frame.contentWindow?.postMessage({ source: "lucid-chrome", type: "ping", nonce }, "*");
    });
  });
};

/**
 * Wait until nothing on the page is moving.
 *
 * Every measurement below is a question about geometry, and geometry is a
 * moving target while an animation runs. `reducedMotion: "reduce"` collapses
 * durations to 0.01ms rather than zero (a 0s transition never fires
 * `transitionend` on a 0s transition), so there is still a frame where things
 * are in flight - and
 * `getAnimations` is the only way to ask the browser rather than guess with a
 * sleep, which is how a suite acquires timing flake it can never reproduce.
 */
export const settled = async (page: Page): Promise<void> => {
  // EVERY frame, not just the main one. `document.getAnimations()` is
  // per-document and does not cross into an iframe - and the artifact surface
  // is an iframe, containing the overlay, which is the most animated part of
  // the product. Waiting only on the main frame returned in 25ms while a
  // 2.5s animation was still running in the frame these helpers point at.
  //
  // `{ subtree: true }` belongs to the ELEMENT method; the document form
  // already returns everything in its own document.
  await Promise.all(
    page.frames().map(async (frame) => {
      const running = async (): Promise<string[]> =>
        frame
          .evaluate(() =>
            document
              .getAnimations()
              .filter((a) => a.playState === "running")
              .map(
                (a) => (a as Animation & { animationName?: string }).animationName ?? "anonymous",
              ),
          )
          .catch(() => []); // a frame that navigated away is settled by definition

      const deadline = Date.now() + 5_000;
      for (;;) {
        const names = await running();
        if (names.length === 0) return;
        if (Date.now() > deadline) {
          // Named, because "Timeout 5000ms exceeded" sends the reader to the
          // wrong file. An animation that never ends is usually an infinite
          // one the reduced-motion block did not reach.
          throw new Error(
            `still animating after 5s in ${frame.url() || "about:blank"}: ${names.join(", ")}`,
          );
        }
        await frame.waitForTimeout(50);
      }
    }),
  );
};

/** A rectangle, as the browser reports it. */
interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box - it is not rendered");
  return box;
};

/**
 * The five things a visual defect looks like from outside (D-003).
 *
 * Each is a measurement rather than a screenshot: a screenshot tells you
 * something changed, a measurement tells you what is wrong and by how much, and
 * only the second one survives a font-rendering difference between machines.
 *
 * They live here rather than in each suite because the same five questions come
 * up in most of the uncovered scenarios, and thirty hand-rolled copies would
 * drift into thirty slightly different definitions of "overlaps".
 */

/** Do two elements overlap? The badge-on-the-previous-card defect (42842f3). */
export const overlaps = async (a: Locator, b: Locator): Promise<boolean> => {
  const [ra, rb] = await Promise.all([boxOf(a), boxOf(b)]);
  const dx = Math.min(ra.x + ra.width, rb.x + rb.width) - Math.max(ra.x, rb.x);
  const dy = Math.min(ra.y + ra.height, rb.y + rb.height) - Math.max(ra.y, rb.y);
  // Touching edges are not an overlap - two cards flush against each other are
  // the normal case, not a defect. But an element with no area still overlaps
  // ITSELF, and a strict `> 0` said otherwise, which broke the one invariant
  // that has no exceptions.
  const same = ra.x === rb.x && ra.y === rb.y && ra.width === rb.width && ra.height === rb.height;
  if (same) return true;
  return dx > 0 && dy > 0;
};

/**
 * How far this element can be scrolled sideways - 0 when it cannot be.
 *
 * `scrollWidth - clientWidth` alone is overflow, not scrollability: a
 * `truncate` container or an `overflow: visible` box reports hundreds of pixels
 * it will never scroll, and a reader takes that for the defect. The computed
 * `overflow-x` is what separates "clipped by design" from "the reader is handed
 * a scrollbar" (a7c3e12).
 */
export const scrollsSideways = async (locator: Locator): Promise<number> =>
  locator.evaluate((el: Element) => {
    const overflowX = getComputedStyle(el).overflowX;
    if (overflowX === "hidden" || overflowX === "visible" || overflowX === "clip") return 0;
    return Math.max(0, el.scrollWidth - el.clientWidth);
  });

/**
 * Is the element wholly inside its container's box - not under a sticky header,
 * below the fold, or off to one side? (c9d7f86's other half)
 *
 * BOTH axes. Checking only Y called a child 900px to the right of a 200px-wide
 * container "fully visible", which is the answer nobody wants from a function
 * with this name.
 *
 * The 1px tolerance is for sub-pixel layout: a child sitting exactly on its
 * container's edge measures a fraction over on a fractional-DPI display, and
 * that is not the defect this is looking for.
 */
export const fullyVisibleIn = async (child: Locator, container: Locator): Promise<boolean> => {
  const [c, box] = await Promise.all([boxOf(child), boxOf(container)]);
  return (
    c.y >= box.y - 1 &&
    c.y + c.height <= box.y + box.height + 1 &&
    c.x >= box.x - 1 &&
    c.x + c.width <= box.x + box.width + 1
  );
};

/**
 * The contrast ratio between an element's text and what is actually behind it.
 *
 * Composited, and this is the second attempt. The first classified a colour as
 * transparent with `/rgba?\([^)]*,\s*0\s*\)/`, which matches any colour whose
 * LAST component is zero - so `rgb(0, 0, 0)` read as transparent, the walk
 * skipped past it, and black text on a black ground scored 21:1. The single
 * worst pairing a contrast instrument exists to catch got the best possible
 * score.
 *
 * Alpha is composited rather than dropped, in both directions: a `rgba(…, 0.06)`
 * veil over near-black is not the opaque colour it names, and text at
 * `rgba(0, 0, 0, 0.05)` is invisible however good its nominal ratio looks.
 *
 * `background-image` is the one case this cannot answer - a gradient has no
 * single colour - so it throws rather than reporting the layer underneath and
 * letting a caller believe it measured something.
 */
export const contrastRatio = async (locator: Locator): Promise<number> =>
  locator.evaluate((el: Element) => {
    /** `rgb()` / `rgba()` to channels plus alpha. */
    const parse = (css: string): [number, number, number, number] => {
      const n = (css.match(/[\d.]+/g) ?? []).map(Number);
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
    };
    /** `over` composited onto `under`, both opaque out. */
    const over = (
      top: [number, number, number, number],
      bottom: [number, number, number, number],
    ): [number, number, number, number] => {
      const a = top[3];
      return [
        top[0] * a + bottom[0] * (1 - a),
        top[1] * a + bottom[1] * (1 - a),
        top[2] * a + bottom[2] * (1 - a),
        1,
      ];
    };
    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const channel = (v: number): number => {
        const srgb = v / 255;
        return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };

    // Walk up compositing every layer, so a semi-transparent veil counts for
    // exactly as much as it covers. The canvas underneath everything is the
    // body's own background, not an assumed white - in a chrome this dark,
    // assuming white silently inverts the answer.
    const layers: Array<[number, number, number, number]> = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") {
        throw new Error(
          `contrastRatio cannot measure ${node.tagName.toLowerCase()}: it has a background-image, which has no single colour`,
        );
      }
      const colour = parse(style.backgroundColor);
      if (colour[3] > 0) layers.push(colour);
      if (colour[3] === 1) break;
    }
    const canvas: [number, number, number, number] = parse(
      getComputedStyle(document.body).backgroundColor,
    );
    const behind = layers.reduceRight(
      (under, layer) => over(layer, under),
      canvas[3] === 1 ? canvas : ([255, 255, 255, 1] as [number, number, number, number]),
    );
    // The text itself can be translucent, and then it is painted ON the stack
    // above rather than being the colour it declares.
    const text = over(parse(getComputedStyle(el).color), behind);

    const a = luminance(text);
    const b = luminance(behind);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
  });

/**
 * Is the point a person would click actually this element, or something
 * invisible on top of it?
 *
 * Scrolled into view FIRST. `elementFromPoint` is viewport-relative and returns
 * null for anything outside it, so an element further down a scrolling thread -
 * the normal case, not an edge one - read as "not hittable" while
 * `locator.click()` on the same element succeeded, because Playwright scrolls
 * before clicking. That conflated "something is covering this" with "you have
 * not scrolled there yet", and only the first is a defect.
 *
 * `composedPath()` rather than `contains`, because `elementFromPoint` returns
 * the shadow HOST for anything inside a shadow root - which is everything the
 * overlay draws.
 */
export const isHittable = async (locator: Locator): Promise<boolean> => {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const at = document.elementFromPoint(x, y);
    if (!at) return false;
    if (at === el || el.contains(at)) return true;
    // The host case: walk out through shadow boundaries.
    let node: Node | null = at;
    while (node) {
      if (node === el) return true;
      node = node.parentNode ?? (node as ShadowRoot).host ?? null;
    }
    return false;
  });
};
