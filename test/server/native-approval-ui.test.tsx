import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalDecision, ApprovalState } from "../../src/protocol/native-approvals.js";
import { NativeApproval } from "../../src/server/client/native-approval.js";

// Synthetic request: approval details remain inert and complete in the browser.
const pending: ApprovalState = {
  attempt: 1,
  epoch: 1,
  inputId: "input",
  turnId: "turn",
  seq: 1,
  status: "pending",
  request: {
    v: 1,
    kind: "approval-request",
    requestId: "207feafe-e82b-4df4-91ba-4f1aeb987508",
    sessionId: "native-session",
    turnId: "native-turn",
    category: "command",
    details:
      "<script>window.approved = true</script>\nhttps://example.test/permission\n" +
      "full scope ".repeat(300),
    choices: [
      { id: "once", label: "Approve once", scope: "once" },
      { id: "deny", label: "Deny", scope: "deny" },
    ],
  },
};

test("permission controls preserve untrusted details, save one explicit choice and never send on remount", async () => {
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
  const sent: ApprovalDecision[] = [];
  let finish: (result: string | null) => void = () => {};
  const send = (decision: ApprovalDecision): Promise<string | null> => {
    sent.push(decision);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const render = (entry: ApprovalState, key = "request") =>
    React.act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <NativeApproval disabled={false} entry={entry} key={key} send={send} />
        </QueryClientProvider>,
      ),
    );
  try {
    await render(pending);
    expect(sent).toHaveLength(0);
    expect(container.querySelector("pre")?.textContent).toBe(pending.request.details);
    expect(container.querySelector("script, a")).toBeNull();
    const buttons = container.querySelectorAll("button");
    await React.act(async () => {
      buttons[0]?.click();
      buttons[0]?.click();
      buttons[1]?.click();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.choiceId).toBe("once");
    expect(sent[0]?.id).toMatch(/^[a-f0-9-]{36}$/);
    await React.act(async () => {
      finish(null);
    });
    const saved = sent[0];
    if (!saved) throw new Error("Expected a saved choice");
    const decision = { ...saved, status: "sending" as const };
    await render({ ...pending, status: "unavailable", reason: "process-ended", decision });
    expect(container.textContent).toContain("Delivery is unknown");
    expect(container.querySelector("button")).toBeNull();
    await render(
      {
        ...pending,
        status: "unavailable",
        reason: "process-ended",
        decision: { ...decision, status: "decided" },
      },
      "reload",
    );
    expect(container.textContent).toContain("was saved but was not sent");
    expect(sent).toHaveLength(1);
    await render({ ...pending, status: "unavailable", reason: "process-unverified" });
    expect(container.textContent).toContain("cannot verify the waiting process");
    expect(container.textContent).not.toContain("session stopped");
    expect(container.querySelector("button")).toBeNull();
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
