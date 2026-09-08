import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { useConversationPanel } from "../../src/server/client/conversation-panel.js";

const View = (props: { search: string; update: string }) => {
  const panel = useConversationPanel(props.search);
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
    expect(first.getAttribute("aria-label")).toBe("Hide conversation");
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
