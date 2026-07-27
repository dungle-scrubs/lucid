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
