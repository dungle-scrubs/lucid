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
 * durations to 0.01ms rather than zero (a zero-duration animation never fires
 * `animationend`), so there is still a frame where things are in flight - and
 * `getAnimations` is the only way to ask the browser rather than guess with a
 * sleep, which is how a suite acquires timing flake it can never reproduce.
 */
export const settled = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    // `document.getAnimations()` takes no options - `{ subtree: true }` belongs
    // to the ELEMENT method. The document form already returns every animation
    // in the document, which is what the plan's row asked for.
    () => document.getAnimations().every((a) => a.playState !== "running"),
    undefined,
    { timeout: 5_000 },
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
  return dx > 0 && dy > 0;
};

/** Is this element clipped by its own scroll container, horizontally? (a7c3e12) */
export const scrollsSideways = async (locator: Locator): Promise<number> =>
  locator.evaluate((el: Element) => el.scrollWidth - el.clientWidth);

/** Is the element inside its container's visible box, rather than under a
 *  sticky header or below the fold? (c9d7f86's other half) */
export const fullyVisibleIn = async (child: Locator, container: Locator): Promise<boolean> => {
  const [c, box] = await Promise.all([boxOf(child), boxOf(container)]);
  return c.y >= box.y - 1 && c.y + c.height <= box.y + box.height + 1;
};

/**
 * The contrast ratio between an element's text and what is actually behind it.
 *
 * Composited, not declared: `color` against `background-color` is a lie the
 * moment the element's own background is transparent, which is the common case
 * and exactly where an unreadable pairing hides.
 */
export const contrastRatio = async (locator: Locator): Promise<number> =>
  locator.evaluate((el: Element) => {
    const lum = (rgb: string): number => {
      const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number) as [
        number,
        number,
        number,
      ];
      const channel = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    // Walk up until something actually paints: a transparent background means
    // the colour behind the text belongs to an ancestor.
    let node: HTMLElement | null = el as HTMLElement;
    let behind = "rgb(255, 255, 255)";
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !/rgba?\([^)]*,\s*0\s*\)/.test(bg) && bg !== "transparent") {
        behind = bg;
        break;
      }
      node = node.parentElement;
    }
    const fg = lum(getComputedStyle(el as HTMLElement).color);
    const bgLum = lum(behind);
    const [hi, lo] = fg > bgLum ? [fg, bgLum] : [bgLum, fg];
    return (hi + 0.05) / (lo + 0.05);
  });

/** Is the point a person would click actually this element, or something
 *  invisible on top of it? (the hit-test capability, in one function) */
export const isHittable = async (locator: Locator): Promise<boolean> =>
  locator.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return at === el || el.contains(at);
  });
