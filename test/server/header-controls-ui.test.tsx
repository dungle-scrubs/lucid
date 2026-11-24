import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { BrowserConnection } from "../../src/protocol/connection-status.js";
import { getBrowserTheme } from "../../src/server/client/browser-theme.js";
import { useConversationPanel } from "../../src/server/client/conversation-panel.js";
import { HeaderConnection } from "../../src/server/client/header-connection.js";
import { NativeConnection } from "../../src/server/client/native-connection.js";
import { THEME_KEY } from "../../src/server/client/theme.js";
import { ThemeControls } from "../../src/server/client/theme-controls.js";
import { Tooltip } from "../../src/server/client/tooltip.js";

// Synthetic HTTP projection: no native session or command is started by this UI test.
const connection: BrowserConnection = {
  actions: ["retry-detection"],
  conversationId: "record-one",
  inputs: [],
  instructions: [],
  interface: "claude-cli",
  message: "No session is listening for this conversation.",
  nativeConnectionRequired: true,
  nativeSessionId: null,
  observedAt: 1000,
  reason: "not-listening",
  savedPreference: null,
  state: "not-listening",
};

/** A JSDOM page installed as the global browser for one test. */
const browserPage = (darkSystem = false) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  const media = new dom.window.EventTarget();
  Object.defineProperty(media, "matches", { get: () => darkSystem });
  Object.defineProperty(dom.window, "matchMedia", { value: () => media });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    // Radix measures floating content; JSDOM has no ResizeObserver.
    ResizeObserver: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root") as HTMLElement;
  return {
    container,
    dom,
    root: createRoot(container),
    restore: () => {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

const Chat = () => {
  const panel = useConversationPanel("", false, "header-focus");
  const heading = React.useRef<HTMLHeadingElement>(null);
  const request = async (): Promise<Response> => Response.json(connection);
  return (
    <>
      <span className="header-controls">
        {panel.open ? null : (
          <HeaderConnection
            conversationId="record-one"
            enabled
            onOpen={() => panel.show(() => heading.current)}
            request={request}
          />
        )}
        {panel.control}
      </span>
      <div {...panel.panelProps}>
        <NativeConnection
          conversationId="record-one"
          enabled={panel.open}
          headingRef={heading}
          request={request}
        />
      </div>
    </>
  );
};

test("opening chat from the header status moves focus to the connection card", async () => {
  const page = browserPage();
  const client = new QueryClient();
  try {
    await React.act(() =>
      page.root.render(
        <QueryClientProvider client={client}>
          <Tooltip.Provider>
            <Chat />
          </Tooltip.Provider>
        </QueryClientProvider>,
      ),
    );
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const status = page.container.querySelector(".header-connection") as HTMLButtonElement;
    expect(status.textContent).toBe("Not connected");
    status.focus();
    await React.act(() => status.click());
    const focused = page.dom.window.document.activeElement;
    expect(focused?.tagName).toBe("H3");
    expect(focused?.textContent).toBe("Current connection");
    expect(page.container.querySelector(".header-connection")).toBeNull();
  } finally {
    await React.act(() => page.root.unmount());
    client.clear();
    page.restore();
  }
});

test("a fixed-theme document's note is a button that opens its explanation, without hover", async () => {
  const page = browserPage();
  const darkOnly =
    "<!doctype html><html><head><meta name='lucid-theme' content='dark'></head><body></body></html>";
  try {
    page.dom.window.localStorage.setItem(THEME_KEY, "light");
    await React.act(() =>
      page.root.render(
        <Tooltip.Provider>
          <ThemeControls documentBytes={darkOnly} />
        </Tooltip.Provider>,
      ),
    );
    const note = page.container.querySelector(".theme-document-note") as HTMLButtonElement;
    expect(note.tagName).toBe("BUTTON");
    expect(note.textContent).toBe("Page is dark only");
    expect(note.getAttribute("aria-label")).toContain("Why the toggle");
    expect(page.dom.window.document.body.textContent).not.toContain("fixed dark theme");
    await React.act(async () => {
      note.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(note.getAttribute("aria-expanded")).toBe("true");
    expect(note.getAttribute("aria-haspopup")).toBe("dialog");
    // Radix chooses its layout effect when imported, before this test installs
    // a DOM, so the portalled text is checked in a real browser instead.
  } finally {
    await React.act(() => page.root.unmount());
    getBrowserTheme().dispose();
    page.restore();
  }
});
