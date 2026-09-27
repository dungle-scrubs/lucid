import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { BrowserConnection } from "../../src/protocol/connection-status.js";
import { NativeConnection } from "../../src/server/client/native-connection.js";

// Synthetic HTTP projection: no native session or command is started by this UI test.
const initial: BrowserConnection = {
  actions: ["retry-detection"],
  conversationId: "record-one",
  inputs: [],
  instructions: [],
  interface: "codex-cli",
  message: "Cannot confirm whether the session is open.",
  nativeConnectionRequired: true,
  nativeSessionId: "native-one",
  observedAt: 1000,
  reason: "owner-unknown",
  savedPreference: null,
  state: "owner-unknown",
};

test("connection refresh keeps focus, announces only changed status and hides stale instructions", async () => {
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
  const client = new QueryClient();
  let value = initial;
  let fail = false;
  let requests = 0;
  const request = async (): Promise<Response> => {
    requests += 1;
    return fail ? new Response(null, { status: 503 }) : Response.json(value);
  };
  const flush = async (): Promise<void> => {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <NativeConnection conversationId="record-one" enabled request={request} />
        </QueryClientProvider>,
      ),
    );
    await flush();
    expect(container.textContent).toContain("native-one");
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Retry session detection");
    button?.focus();
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(initial.message);
    let announcements = 0;
    const observer = new dom.window.MutationObserver(() => {
      announcements += 1;
    });
    if (!status) throw new Error("Expected one live status region");
    observer.observe(status, { characterData: true, childList: true, subtree: true });
    value = { ...initial, observedAt: 3000 };
    await React.act(() => {
      button?.click();
    });
    await flush();
    expect(requests).toBe(2);
    expect(announcements).toBe(0);
    expect(dom.window.document.activeElement).toBe(button);
    value = {
      ...initial,
      actions: ["resume-listening-instructions"],
      instructions: [
        {
          action: "resume-listening-instructions",
          command: "<script>not executable</script> 'record-one'",
          label: "Resume listening instructions",
          text: "Run once in the existing native session.",
        },
      ],
      message: "Your interactive session is still open. Tell it to resume listening.",
      observedAt: 5000,
      state: "not-listening",
    };
    await React.act(() => {
      button?.click();
    });
    await flush();
    expect(dom.window.document.activeElement).toBe(button);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(value.instructions[0]?.command ?? "");
    expect(announcements).toBe(1);
    fail = true;
    await React.act(() => {
      button?.click();
    });
    await flush();
    expect(container.textContent).toContain("Current connection could not be checked");
    expect(container.querySelector("pre")).toBeNull();
    expect(dom.window.document.activeElement).toBe(button);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    observer.disconnect();
    const pending = Promise.withResolvers<Response>();
    let obsolete: AbortSignal | undefined;
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <NativeConnection
            key="record-two"
            conversationId="record-two"
            enabled
            request={(signal) => {
              obsolete = signal;
              return pending.promise;
            }}
          />
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).not.toContain("native-one");
    const unbound: BrowserConnection = {
      ...initial,
      actions: ["setup-instructions"],
      interface: null,
      nativeSessionId: null,
      message: "Last connection attempt: no verified registration. Saved feedback remains held.",
      state: "setup-required",
      instructions: [
        {
          action: "setup-instructions",
          command: null,
          label: "Connect the publishing session",
          text: "Repeat publication into record-four after repairing registration.",
        },
      ],
    };
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <NativeConnection
            key="record-four"
            conversationId="record-four"
            enabled
            request={async () => Response.json(unbound)}
          />
        </QueryClientProvider>,
      ),
    );
    await flush();
    expect(container.textContent).toContain("Native session identity is not verified yet.");
    expect(container.textContent).toContain("Repeat publication into record-four");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(unbound.message);
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <NativeConnection
            key="ordinary"
            conversationId="ordinary"
            enabled
            request={async () => Response.json({ ...unbound, nativeConnectionRequired: false })}
          />
        </QueryClientProvider>,
      ),
    );
    await flush();
    expect(container.querySelector("section")).toBeNull();
    await React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <NativeConnection
            key="record-three"
            conversationId="record-three"
            enabled
            request={async () =>
              Response.json({
                ...initial,
                conversationId: "record-three",
                nativeSessionId: "native-three",
              })
            }
          />
        </QueryClientProvider>,
      ),
    );
    expect(obsolete?.aborted).toBe(true);
    await React.act(() => {
      pending.resolve(Response.json(initial));
    });
    await flush();
    expect(container.textContent).toContain("native-three");
    expect(container.textContent).not.toContain("native-one");
  } finally {
    await React.act(() => root.unmount());
    client.clear();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
