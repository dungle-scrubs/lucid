// A SECOND shell window, and asking both of them the same question.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones add tests, never harness: an agent that needs to change something
// here has been scoped wrong, and the split is what makes that visible rather
// than a merge conflict nobody reads.

import type { Browser, Page } from "@playwright/test";

/**
 * A shell window that is not the `page` fixture.
 *
 * `browser.newContext()` rather than `context.newPage()`: two pages in one
 * context share localStorage and cookies, so a draft or a folded-state write by
 * one would arrive in the other through storage rather than through the
 * product's own broadcast - which is the exact thing these scenarios measure.
 * Two contexts are two windows the way two windows really are.
 */
export interface ShellWindow {
  readonly page: Page;
  /** Closes the whole context, so nothing survives the test that opened it. */
  close(): Promise<void>;
}

export const secondWindow = async (browser: Browser, url: string): Promise<ShellWindow> => {
  // `reducedMotion` is NOT inherited. `playwright.config.ts` sets it under
  // `use.contextOptions`, which the runner applies when IT builds the `page`
  // fixture's context - a context made here gets the browser default, so the
  // second window would animate while the first does not, and any geometry
  // asserted across the pair would be measured on two different products.
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(url);
  return { page, close: () => context.close() };
};

/**
 * Run the same assertion against every open window, naming the one that failed.
 *
 * The naming is the point. Two windows fail identically as far as Playwright is
 * concerned - "expected 2, got 1" says nothing about WHICH window missed the
 * broadcast, and "the second one" is the entire finding in a scenario about
 * whether an event reached both.
 */
export const inEveryWindow = async (
  windows: readonly Page[],
  assertion: (page: Page) => Promise<void>,
): Promise<void> => {
  for (const [index, page] of windows.entries()) {
    try {
      await assertion(page);
    } catch (error) {
      throw new Error(`window ${index + 1} of ${windows.length}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
};
