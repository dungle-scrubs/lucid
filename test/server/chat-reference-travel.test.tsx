/**
 * A chat reference link travels to its block.
 *
 * The case the feature exists for: the agent quoted a passage, the quote
 * resolved against the version on screen, and clicking the link hands that
 * block's element id to the same `focusSpot` path a note card uses. The
 * frame's own focus behavior is proven by the instrument tests; this proves
 * the production `ChatSpans` renderer maps a resolved label to its element
 * id on click, and leaves unresolved labels as prose.
 */
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { resolveChatReferences, splitChatLabels } from "../../src/server/client/chat-references.js";
import { ChatSpans } from "../../src/server/client/chat-spans.js";
import "../support/dom.js";

const DOC = `<!doctype html><html><body>
<h1>Field notes</h1>
<p>The upper catchment holds water longer than the open pasture.</p>
<h2>Next survey</h2>
<p>Keep the next survey focused on the stream edge.</p>
</body></html>`;

const mount = async (container: HTMLElement, ui: React.ReactElement): Promise<() => void> => {
  const root = createRoot(container);
  await React.act(() => root.render(ui));
  return () => {
    void React.act(() => root.unmount());
  };
};

const setup = (): { container: HTMLElement; restore: () => void } => {
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
  return {
    container: dom.window.document.getElementById("root") as HTMLElement,
    restore: () => {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

test("clicking a resolved chat reference travels to its block", async () => {
  const { container, restore } = setup();
  try {
    const resolved = resolveChatReferences(
      DOC,
      2,
      [
        {
          artifactId: "doc-1",
          version: 2,
          refs: [{ quote: "Keep the next survey focused on the stream edge.", label: "Survey" }],
        },
      ],
      "doc-1",
    );
    // DOC elements in order: H1, P, H2, P(survey). The quote names e4.
    // Asserted literally so a resolver change cannot fake the travel.
    expect(resolved[0]).toMatchObject({ elementId: "e4" });
    const target = "e4";
    const travelled: string[] = [];
    const unmount = await mount(
      container,
      <ChatSpans
        parts={splitChatLabels("See the [Survey] for details.")}
        lookup={(label) => (label === "Survey" ? target : null)}
        onGo={(id) => travelled.push(id)}
      />,
    );
    const button = container.querySelector("button.chat-ref") as HTMLButtonElement | null;
    expect(button?.textContent).toBe("Survey");
    expect(button?.getAttribute("aria-label")).toBe("Go to Survey in the document");
    await React.act(() => button?.click());
    // The literal element id travels - the same id the frame focus
    // handler lights in place.
    expect(travelled).toEqual([target]);
    unmount();
  } finally {
    restore();
  }
});

test("an unresolved label renders as prose with no button", async () => {
  const { container, restore } = setup();
  try {
    const unmount = await mount(
      container,
      <ChatSpans
        parts={splitChatLabels("See the [Missing section] for details.")}
        lookup={() => null}
        onGo={() => {}}
      />,
    );
    expect(container.querySelector("button.chat-ref")).toBeNull();
    expect(container.querySelector("p")?.textContent).toContain("[Missing section]");
    unmount();
  } finally {
    restore();
  }
});

test("the same label in two messages travels to its own message target", async () => {
  // The map key is message id plus label. Two messages quoting under one
  // label must not share a target.
  const { container, restore } = setup();
  try {
    const byMessage = new Map([
      ["m1\0Survey", "e2"],
      ["m2\0Survey", "e4"],
    ]);
    const travelled: string[] = [];
    const unmount = await mount(
      container,
      <>
        <ChatSpans
          parts={splitChatLabels("First: [Survey].")}
          lookup={(label) => byMessage.get(`m1\0${label}`) ?? null}
          onGo={(id) => travelled.push(id)}
        />
        <ChatSpans
          parts={splitChatLabels("Second: [Survey].")}
          lookup={(label) => byMessage.get(`m2\0${label}`) ?? null}
          onGo={(id) => travelled.push(id)}
        />
      </>,
    );
    const buttons = [...container.querySelectorAll("button.chat-ref")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Survey", "Survey"]);
    await React.act(() => (buttons[0] as HTMLButtonElement).click());
    await React.act(() => (buttons[1] as HTMLButtonElement).click());
    expect(travelled).toEqual(["e2", "e4"]);
    unmount();
  } finally {
    restore();
  }
});

test("a null travel path renders prose even for a resolved label", async () => {
  // No document on screen: the page supplies no `focusSpot`, so `onGo` is
  // null and the link stays prose. The pinned-version case flows through
  // `goToSpot`, which returns early on `pinnedOld`; that predicate is
  // pinned by the `chatLinkTravels` unit tests.
  const { container, restore } = setup();
  try {
    const unmount = await mount(
      container,
      <ChatSpans
        parts={splitChatLabels("See the [Survey] for details.")}
        lookup={() => "e3"}
        onGo={null}
      />,
    );
    expect(container.querySelector("button.chat-ref")).toBeNull();
    expect(container.querySelector("p")?.textContent).toContain("[Survey]");
    unmount();
  } finally {
    restore();
  }
});
