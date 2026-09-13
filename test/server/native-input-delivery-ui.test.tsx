import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import type { NativeInputDelivery as Delivery } from "../../src/protocol/connection-status.js";
import { NativeInputDelivery } from "../../src/server/client/native-input-delivery.js";

test("message delivery labels retain outcome meaning and use keyboard-accessible details without another live region", () => {
  const cases: readonly [Delivery["state"], Delivery["outcome"], string][] = [
    ["saved", null, "Saved"],
    ["sending", null, "Sending"],
    ["received", null, "Received"],
    ["delivery-uncertain", null, "Delivery uncertain"],
    ["cancelled", null, "Cancelled"],
    ["not-started", { kind: "refusal", text: "Unsupported" }, "Not started"],
    ["finished", null, "Response ended"],
    ["finished", { kind: "answer", text: "Updated" }, "Response finished"],
    ["finished", { kind: "question", text: "Which part?" }, "Question received"],
    ["finished", { kind: "refusal", text: "Refused" }, "Response refused"],
    ["finished", { kind: "failure", text: "Failed" }, "Response failed"],
  ];
  for (const [state, outcome, label] of cases) {
    const dom = new JSDOM(
      renderToStaticMarkup(
        <NativeInputDelivery
          delivery={{ inputId: "durable-input", message: "Recorded explanation", outcome, state }}
        />,
      ),
    );
    try {
      expect(
        dom.window.document.querySelector("details[data-input-id='durable-input'] summary")
          ?.textContent,
      ).toBe(label);
      expect(dom.window.document.querySelector("summary")?.getAttribute("aria-label")).toBe(
        `Message delivery: ${label}`,
      );
      expect(dom.window.document.querySelector("details p")?.textContent).toBe(
        "Recorded explanation",
      );
      expect(
        dom.window.document.querySelectorAll("[aria-live], [role=status], button"),
      ).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  }
  expect(renderToStaticMarkup(<NativeInputDelivery delivery={undefined} />)).toBe("");
});
