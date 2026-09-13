import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type {
  BrowserConnection,
  NativeInputDelivery as Delivery,
} from "../../src/protocol/connection-status.js";
import { NativeConnection } from "../../src/server/client/native-connection.js";
import { NativeInputControlsProvider } from "../../src/server/client/native-input-controls.js";
import { NativeInputDelivery } from "../../src/server/client/native-input-delivery.js";

test.each(["confirmed", "lost-response", "receipt-after-loss", "offered-before-click"] as const)(
  "native cancellation %s preserves focus, avoids duplicate writes and uses one announcement region",
  async (scenario) => {
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
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
    let calls = 0;
    let reads = 0;
    let release: (response: Response) => void = () => {
      throw new Error("No request pending");
    };
    let delivery: Delivery = {
      actions: ["cancel-unsent-input"],
      inputId: "saved-one",
      message: "Saved feedback",
      outcome: null,
      state: "saved",
    };
    const read = async (): Promise<Response> => {
      reads += 1;
      const connection: BrowserConnection = {
        actions: [],
        conversationId: "cancel-record",
        inputs: [delivery],
        instructions: [],
        interface: "codex-cli",
        message: "The native session is open.",
        nativeConnectionRequired: true,
        nativeSessionId: "native-one",
        observedAt: reads,
        reason: null,
        savedPreference: null,
        state: "not-listening",
      };
      return Response.json(connection);
    };
    const cancel = async (): Promise<Response> => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const render = async (key = "initial"): Promise<void> => {
      await React.act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <NativeInputControlsProvider
              key={key}
              conversationId="cancel-record"
              enabled
              cancel={cancel}
            >
              <NativeConnection conversationId="cancel-record" enabled request={read} />
              <NativeInputDelivery delivery={delivery} />
            </NativeInputControlsProvider>
          </QueryClientProvider>,
        );
      });
    };
    const flush = async (): Promise<void> => {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    try {
      await render();
      await flush();
      await flush();
      const details = container.querySelector(".native-input-delivery") as HTMLDetailsElement;
      details.open = true;
      const button = details.querySelector("button") as HTMLButtonElement;
      button.focus();
      if (scenario === "offered-before-click") {
        delivery = { ...delivery, actions: [], state: "sending" };
        await render();
        expect(dom.window.document.activeElement === button).toBe(true);
        expect(button.textContent).toBe("Cancellation unavailable");
        await React.act(async () => {
          button.click();
        });
        expect(calls).toBe(0);
        delivery = { ...delivery, inputId: "another-input", state: "received" };
        await render();
        expect(details.querySelector("button")).toBeNull();
        return;
      }
      await React.act(async () => {
        button.click();
        button.click();
      });
      await flush();
      expect(calls).toBe(1);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      const priorReads = reads;
      await React.act(async () => {
        release(
          scenario === "confirmed"
            ? Response.json({ inputId: "saved-one", status: "cancelled" })
            : new Response("unreadable", { status: 503 }),
        );
      });
      await flush();
      await flush();
      expect(reads).toBeGreaterThan(priorReads);
      expect(calls).toBe(1);
      if (scenario !== "lost-response") {
        delivery = { ...delivery, actions: [], state: "cancelled" };
        await render();
        await flush();
        expect(button.textContent).toBe("Cancelled");
        expect(details.querySelector("summary")?.textContent).toBe("Cancelled");
        expect(details.textContent).not.toContain("Cancellation was not confirmed");
        expect(container.querySelector('[role="status"]')?.textContent).toContain(
          "Message cancelled before dispatch",
        );
      } else {
        expect(button.textContent).toBe("Retry cancellation");
        const check = [...details.querySelectorAll("button")].find(
          (entry) => entry.textContent === "Check status",
        );
        expect(check).toBeDefined();
        await React.act(async () => {
          check?.click();
        });
        await flush();
        expect(calls).toBe(1);
        expect(container.querySelector('[role="status"]')?.textContent).toContain(
          "Checking cancellation status",
        );
      }
      expect(dom.window.document.activeElement === button).toBe(true);
      expect(details.open).toBe(true);
      expect(container.querySelectorAll('[role="status"], [aria-live="polite"]')).toHaveLength(1);
      await render("reload");
      await flush();
      expect(calls).toBe(1);
    } finally {
      await React.act(async () => {
        root.unmount();
      });
      client.clear();
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  },
);
