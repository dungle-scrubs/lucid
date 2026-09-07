import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServe } from "../../src/cli/serve.js";
import { createInputSubmission } from "../../src/server/client/input-submission.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

class TabStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("unusable recovery data stays visible and cannot send until explicitly discarded", async () => {
  const storage = new TabStorage();
  let calls = 0;
  const options = {
    conversationId: "broken-recovery",
    storage,
    mintId: () => "one-send",
    send: async (): Promise<Response> => {
      calls++;
      throw new Error("Lost response");
    },
  };
  await createInputSubmission(options).submit("A readable saved prompt");
  for (const [key, raw] of storage.values)
    storage.setItem(key, JSON.stringify({ ...JSON.parse(raw), version: 999 }));
  const reloaded = createInputSubmission(options);
  expect(reloaded.current()).toMatchObject({ status: "invalid", text: "A readable saved prompt" });
  expect((await reloaded.retry()).status).toBe("blocked");
  expect((await reloaded.submit("A replacement")).status).toBe("blocked");
  expect(reloaded.discardInvalid()).toBe(true);
  expect(reloaded.current().status).toBe("idle");
  expect(calls).toBe(1);
  expect(storage.values.size).toBe(0);
});

test("a stale controller cannot replace another unresolved send in the same tab", async () => {
  const storage = new TabStorage();
  const sent: string[] = [];
  const make = (inputId: string) =>
    createInputSubmission({
      conversationId: "one-tab",
      storage,
      mintId: () => inputId,
      send: async (body) => {
        sent.push(body);
        throw new Error("Response lost");
      },
    });
  const first = make("first");
  const stale = make("replacement");
  await first.submit("Original text");
  expect((await stale.submit("Do not replace it")).status).toBe("blocked");
  expect(sent).toHaveLength(1);
  expect(make("unused").current()).toMatchObject({ status: "unresolved", text: "Original text" });
});

test("an explicit admission refusal restores the request and clears recovery storage", async () => {
  const storage = new TabStorage();
  const submission = createInputSubmission({
    conversationId: "refused-send",
    mintId: () => "same-input",
    storage,
    send: async () =>
      Response.json(
        { verdict: "refused", inputId: "same-input", error: "input-queue-full" },
        { status: 429 },
      ),
  });
  expect(await submission.submit("Preserve these exact words", "document")).toEqual({
    status: "refused",
    inputId: "same-input",
    artifactId: "document",
    text: "Preserve these exact words",
    reason: "input-queue-full",
  });
  expect(submission.current().status).toBe("idle");
  expect(storage.values.size).toBe(0);
});

test("storage failures and unverified responses never authorize a replacement send", async () => {
  const storage = new TabStorage();
  let writesFail = true;
  let cleanupFails = false;
  let response = new Response("expired", { status: 401 });
  let calls = 0;
  const controller = createInputSubmission({
    conversationId: "storage-failure",
    mintId: () => "saved",
    storage: {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => {
        if (writesFail) throw new Error("Quota exceeded");
        storage.setItem(key, value);
      },
      removeItem: (key) => {
        if (cleanupFails) throw new Error("Storage unavailable");
        storage.removeItem(key);
      },
    },
    send: async () => {
      calls++;
      return response.clone();
    },
  });
  expect((await controller.submit("Keep this prompt")).status).toBe("blocked");
  expect(calls).toBe(0);
  writesFail = false;
  expect(await controller.submit("Keep this prompt")).toMatchObject({
    status: "uncertain",
    reload: true,
  });
  for (const unverified of [
    Response.json({ verdict: "accepted", inputId: "another" }),
    new Response("not JSON"),
    Response.json({ verdict: "refused", error: "input-queue-full" }, { status: 429 }),
  ]) {
    response = unverified;
    expect((await controller.retry()).status).toBe("uncertain");
    expect(controller.current()).toMatchObject({ status: "unresolved", text: "Keep this prompt" });
  }
  response = Response.json({ verdict: "accepted", inputId: "saved" });
  cleanupFails = true;
  expect((await controller.retry()).status).toBe("uncertain");
  expect((await controller.submit("Replacement")).status).toBe("blocked");
  cleanupFails = false;
  expect((await controller.retry()).status).toBe("accepted");
  expect(controller.current().status).toBe("idle");
});

test("a lost response survives reload and server restart without sending another prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-browser-receipt-"));
  const conversationId = "browser-retry";
  createConversationRecord(root, conversationId);
  let server = await startServe({ rootDir: root, port: 0 });
  const storage = new TabStorage();
  const requests: string[] = [];
  const send = async (body: string): Promise<Response> => {
    requests.push(body);
    return fetch(`${server.url}/api/conversations/${conversationId}/input`, {
      method: "POST",
      headers: { "x-lucid-token": server.token, "content-type": "application/json" },
      body,
    });
  };
  try {
    const first = createInputSubmission({
      conversationId,
      storage,
      mintId: () => "browser-fixed",
      send: async (body) => {
        await send(body);
        throw new Error("The accepted response was lost");
      },
    });
    expect((await first.submit("Keep the same prompt")).status).toBe("uncertain");
    expect(first.current().status).toBe("unresolved");
    await server.close();
    server = await startServe({ rootDir: root, port: 0 });
    const reloaded = createInputSubmission({
      conversationId,
      storage,
      mintId: () => "must-not-be-used",
      send,
    });
    expect(reloaded.current().status).toBe("unresolved");
    expect(requests).toHaveLength(1); // Reload never automatically sends.
    expect((await reloaded.submit("A replacement prompt")).status).toBe("blocked");
    expect((await reloaded.retry()).status).toBe("accepted");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(reloaded.current().status).toBe("idle");
    const host = createConversationHost(join(root, conversationId), {
      now: () => 0,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    try {
      expect(host.transcript().inputs.map(({ id, text }) => ({ id, text }))).toEqual([
        { id: "browser-fixed", text: "Keep the same prompt" },
      ]);
    } finally {
      host.close();
    }
  } finally {
    await server.close();
    rmSync(root, { force: true, recursive: true });
  }
});
