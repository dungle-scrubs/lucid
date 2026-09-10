import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { installationProblem } from "../../src/harness/compatibility.js";
import { CompatibilityNotice } from "../../src/server/client/compatibility-notice.js";

test("compatibility details remain accessible beside a closed panel and polling does not announce again", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  const diagnostic = installationProblem({
    path: "/selected/hcn",
    source: "env",
    lookupRoot: null,
  });
  if (!diagnostic) throw new Error("Expected a diagnostic");
  const render = (observedAt: string) =>
    root.render(
      <>
        <button type="button">Keep focus</button>
        <CompatibilityNotice diagnostics={[{ ...diagnostic, observedAt }, diagnostic]} />
        <div aria-hidden="true" {...{ inert: "" }}>
          Closed chat
        </div>
      </>,
    );
  try {
    await React.act(() => render(diagnostic.observedAt));
    const region = container.querySelector('[aria-label="Agent compatibility"]') as HTMLElement;
    expect(region.closest('[aria-hidden="true"], [inert]')).toBeNull();
    expect(region.querySelectorAll("details")).toHaveLength(1);
    const summary = region.querySelector("summary") as HTMLElement;
    summary.focus();
    expect(dom.window.document.activeElement).toBe(summary);
    const live = container.querySelector('[role="status"]') as HTMLElement;
    const before = live.textContent;
    let mutations = 0;
    const observer = new dom.window.MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    await React.act(() => render("2026-09-09T00:00:00.000Z"));
    expect(live.textContent).toBe(before);
    expect(mutations).toBe(0);
    expect(dom.window.document.activeElement).toBe(summary);
    expect(region.textContent).toContain("/selected/hcn");
    expect(region.textContent).not.toMatch(/version|pins|minimum|update/i);
    expect(region.querySelector("button")).toBeNull();
    observer.disconnect();
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
