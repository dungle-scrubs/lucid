import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { useConversationPanel } from "../../src/server/client/conversation-panel.js";

const View = (props: {
  search: string;
  update: string;
  defaultOpen?: boolean;
  viewId?: string;
}) => {
  const panel = useConversationPanel(props.search, props.defaultOpen, props.viewId);
  return (
    <section>
      {panel.control}
      <div {...panel.panelProps}>
        <textarea defaultValue="draft" />
        <button type="button">Panel action</button>
        <p>{props.update}</p>
      </div>
    </section>
  );
};

test("view toggles preserve mounted drafts, focus, and visibility across updates without affecting another view", async () => {
  const dom = new JSDOM("<div id='root'></div>");
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
  const render = (update: string) =>
    root.render(
      <>
        <View search="" update={update} />
        <View search="?conversation-panel=open" update={update} />
      </>,
    );
  try {
    await React.act(() => render("v1"));
    const buttons = container.querySelectorAll("button[aria-controls]");
    const first = buttons[0] as HTMLButtonElement;
    const second = buttons[1] as HTMLButtonElement;
    const panel = dom.window.document.getElementById(
      first.getAttribute("aria-controls") ?? "",
    ) as HTMLElement;
    const draft = panel.querySelector("textarea") as HTMLTextAreaElement;
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("true");
    await React.act(() => first.click());
    expect(panel.hasAttribute("inert")).toBe(false);
    draft.value = "unsent change";
    panel.querySelector("button")?.focus();
    await React.act(() => first.click());
    expect(dom.window.document.activeElement).toBe(first);
    await React.act(() => render("v2 and new message"));
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(panel.querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("unsent change");
    await React.act(() => first.click());
    expect(first.getAttribute("aria-label")).toBe("Hide chat");
    expect(panel.querySelector("p")?.textContent).toBe("v2 and new message");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test.each(["", "?conversation-panel=open"])(
  "manual visibility survives a reload ahead of the URL initializer: %s",
  async (search) => {
    const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
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
    let root = createRoot(container);
    const button = () => container.querySelector("button[aria-controls]") as HTMLButtonElement;
    const initial = search !== "";
    try {
      // Corrupt preferences fall back to the URL rather than breaking the view.
      dom.window.sessionStorage.setItem("lucid:conversation-panel", "invalid");
      await React.act(() => root.render(<View search={search} update="before reload" />));
      expect(button().getAttribute("aria-expanded")).toBe(String(initial));
      await React.act(() => button().click());
      expect(button().getAttribute("aria-expanded")).toBe(String(!initial));

      // A reload mounts a new tree while retaining the tab's session storage.
      await React.act(() => root.unmount());
      root = createRoot(container);
      await React.act(() => root.render(<View search={search} update="after reload" />));
      expect(button().getAttribute("aria-expanded")).toBe(String(!initial));

      // A fresh session has no saved choice and uses the initializer again.
      await React.act(() => root.unmount());
      dom.window.sessionStorage.clear();
      root = createRoot(container);
      await React.act(() => root.render(<View search={search} update="new session" />));
      expect(button().getAttribute("aria-expanded")).toBe(String(initial));
    } finally {
      await React.act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  },
);

test("an empty conversation opens after loading and preserves its own manual choice on reload", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
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
  let root = createRoot(container);
  const render = (defaultOpen: boolean, viewId = "empty") =>
    root.render(<View defaultOpen={defaultOpen} search="" update="" viewId={viewId} />);
  const button = () => container.querySelector("button[aria-controls]") as HTMLButtonElement;
  try {
    dom.window.sessionStorage.setItem("lucid:conversation-panel:other", "closed");
    await React.act(() => render(false));
    expect(button().getAttribute("aria-expanded")).toBe("false");
    await React.act(() => render(true));
    expect(button().getAttribute("aria-expanded")).toBe("true");
    await React.act(() => button().click());
    await React.act(() => root.unmount());
    root = createRoot(container);
    await React.act(() => render(true));
    expect(button().getAttribute("aria-expanded")).toBe("false");
    await React.act(() => root.unmount());
    root = createRoot(container);
    await React.act(() => render(true, "another-empty"));
    expect(button().getAttribute("aria-expanded")).toBe("true");
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
