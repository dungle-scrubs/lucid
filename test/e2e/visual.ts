// Reaching into the artifact surface, and waiting for it to settle.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones in Phase 5 add tests, never harness: an agent that needs to change
// something here has been scoped wrong, and the split is what makes that
// visible rather than a merge conflict nobody reads.

import type { FrameLocator, Page } from "@playwright/test";

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
