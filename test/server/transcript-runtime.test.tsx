import { expect, test } from "bun:test";
import {
  AssistantRuntimeProvider,
  getExternalStoreMessage,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessage,
} from "@assistant-ui/react";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { type Msg, runtimeMessage } from "../../src/server/client/timeline.js";

const Message = () => {
  const original = useMessage((m) => getExternalStoreMessage<Msg>(m));
  const message = Array.isArray(original) ? original[0] : original;
  return (
    <MessagePrimitive.Root>
      <p>{message?.text}</p>
    </MessagePrimitive.Root>
  );
};
const Harness = ({ messages }: { messages: Msg[] }) => {
  const runtime = useExternalStoreRuntime({
    messages,
    onNew: async () => {},
    convertMessage: (m: Msg, index: number) => runtimeMessage(m, index),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages components={{ Message }} />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
};

test("an asynchronously inserted save marker cannot hide an accepted note after reload", async () => {
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
  const note: Msg = { id: "input-one", role: "user", text: "Restore the earlier explanation" };
  const save: Msg = { id: "saved-v3", role: "user", text: "Saved v3", note: true };
  const draft: Msg = { id: "pending", role: "user", text: "Another unsent note" };
  try {
    await React.act(() => root.render(<Harness messages={[note]} />));
    await React.act(() => root.render(<Harness messages={[save, note]} />));
    expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      save.text,
      note.text,
    ]);
    await React.act(() => root.render(<Harness messages={[save, draft, note]} />));
    expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      save.text,
      draft.text,
      note.text,
    ]);
    await React.act(() => root.render(<Harness messages={[save, note]} />));
    expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      save.text,
      note.text,
    ]);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
