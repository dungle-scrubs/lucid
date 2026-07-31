// Interfering with a request on its way to the server.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones in Phase 5 add tests, never harness: an agent that needs to change
// something here has been scoped wrong, and the split is what makes that
// visible rather than a merge conflict nobody reads.

import type { Page, Route } from "@playwright/test";

/**
 * Interfering with a request the page is about to make.
 *
 * Three shapes, because they fail differently and the difference is the point:
 * a slow response is still a response, an aborted one never arrives, and a
 * stubbed error arrives quickly and says something specific. A suite asserting
 * "the composer keeps the message when the server is gone" needs the second;
 * one asserting "a 500 surfaces the server's reason" needs the third.
 *
 * Each takes the URL pattern rather than wrapping a fixed route, so the caller
 * names the endpoint it is talking about at the call site.
 */
export const delayRoute = async (
  page: Page,
  pattern: string | RegExp,
  ms: number,
): Promise<void> => {
  await page.route(pattern, async (route: Route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    // The whole job of this helper is to still be holding a request when
    // something else happens, so the page navigating or closing mid-delay is
    // the LIKELY path, not the exotic one - and `continue()` rejects inside a
    // route handler when it does. Swallowed: the test has already moved on, and
    // an unhandled rejection here would fail whatever ran next instead.
    await route.continue().catch(() => {});
  });
};

/**
 * Hold the live channel's FRAMES up, without holding its connection up.
 *
 * `delayRoute` cannot do this any more and cannot say so: `page.route`
 * intercepts HTTP, and the shell's streams are WebSockets now
 * (client/chrome/stream.ts). A pattern aimed at `/hub/events` simply stops
 * matching - the interception becomes inert while the test still reads as
 * though it interferes, which is the one failure mode this harness is written
 * to avoid. So the socket wire gets its own helper rather than a quietly
 * broken shared one.
 *
 * The socket still opens on time; each frame the server sends arrives `ms`
 * late. That is the state worth standing in - "connected, nothing said yet" -
 * and it is what a screen must tell the truth about while it waits.
 */
export const delaySocketFrames = async (
  page: Page,
  pattern: string | RegExp,
  ms: number,
): Promise<void> => {
  await page.routeWebSocket(pattern, (ws) => {
    // Synchronously, before any await: not calling this inside the handler is
    // how Playwright is told to MOCK the socket instead of connecting it.
    const server = ws.connectToServer();
    // Registering a handler turns automatic forwarding off, so the delayed
    // `send` below is the only way a frame reaches the page - which is exactly
    // the hold this helper is for.
    server.onMessage((message) => {
      setTimeout(() => ws.send(message), ms);
    });
  });
};

/** Make the request fail as though the connection dropped. */
export const abortRoute = async (page: Page, pattern: string | RegExp): Promise<void> => {
  await page.route(pattern, (route: Route) => route.abort("connectionfailed"));
};

/** Answer the request without it reaching the server. */
export const stubRoute = async (
  page: Page,
  pattern: string | RegExp,
  response: { status?: number; body?: string; contentType?: string },
): Promise<void> => {
  await page.route(pattern, (route: Route) =>
    route.fulfill({
      status: response.status ?? 200,
      contentType: response.contentType ?? "application/json",
      body: response.body ?? "{}",
    }),
  );
};
