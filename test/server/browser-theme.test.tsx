import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { getBrowserTheme } from "../../src/server/client/browser-theme.js";
import { THEME_KEY } from "../../src/server/client/theme.js";
import { AppearanceSettings, ThemeControls } from "../../src/server/client/theme-controls.js";

test("browser controls share state, filter storage areas, restore pages, and retain failed choices", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  let dark = false;
  const media = new dom.window.EventTarget();
  Object.defineProperty(media, "matches", { get: () => dark });
  Object.defineProperty(dom.window, "matchMedia", { value: () => media });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  const storage = dom.window.localStorage;
  const select = () => container.querySelector("select") as HTMLSelectElement;
  const toggle = () => container.querySelector(".theme-toggle") as HTMLButtonElement;
  try {
    await React.act(() =>
      root.render(
        <>
          <ThemeControls />
          <AppearanceSettings />
        </>,
      ),
    );
    expect(select().value).toBe("system");
    expect(toggle().getAttribute("aria-label")).toBe("Switch to dark mode");
    await React.act(() => toggle().click());
    expect(select().value).toBe("dark");
    expect(storage.getItem(THEME_KEY)).toBe("dark");
    expect(dom.window.document.documentElement.style.colorScheme).toBe("dark");
    storage.setItem(THEME_KEY, "light");
    await React.act(() =>
      dom.window.dispatchEvent(
        new dom.window.StorageEvent("storage", {
          key: null,
          storageArea: dom.window.sessionStorage,
        }),
      ),
    );
    expect(select().value).toBe("dark");
    await React.act(() =>
      dom.window.dispatchEvent(
        new dom.window.StorageEvent("storage", { key: THEME_KEY, storageArea: storage }),
      ),
    );
    expect(select().value).toBe("light");
    storage.removeItem(THEME_KEY);
    dark = true;
    await React.act(() => dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow")));
    expect(select().value).toBe("system");
    expect(dom.window.document.documentElement.classList.contains("dark")).toBe(true);
    dark = false;
    await React.act(() => media.dispatchEvent(new dom.window.Event("change")));
    expect(toggle().getAttribute("aria-label")).toBe("Switch to dark mode");
    Object.defineProperty(dom.window, "localStorage", {
      get: () => {
        throw new Error("denied");
      },
    });
    await React.act(() => toggle().click());
    expect(select().value).toBe("dark");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Appearance applies here but could not be saved.",
    );
    await React.act(() => dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pageshow")));
    expect(select().value).toBe("dark");
  } finally {
    await React.act(() => root.unmount());
    getBrowserTheme().dispose();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
