import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { startServe } from "../../src/cli/serve.js";
import { encodeAnnotationBatch } from "../../src/protocol/annotations.js";
import { encodeFrame, TEXT_MAX } from "../../src/protocol/frames.js";
import type { InputRecoveryDeps } from "../../src/server/client/input-recovery.js";
import { createInputRecovery, recoveryKey } from "../../src/server/client/input-recovery.js";
import { InputRecoveryPanel } from "../../src/server/client/input-recovery-panel.js";
import { openWriter } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";
import { attach } from "../protocol/helpers.js";

const CONV = "recovery";
const NOTE = encodeAnnotationBatch({
  artifactId: "doc",
  notes: [
    { note: "Bring this back", spots: [{ author: "agent", id: "e1", snippet: "Earlier words" }] },
  ],
  version: 1,
});
let root: string;
let server: Awaited<ReturnType<typeof startServe>>;
let dom: JSDOM;
let storage: Storage;
let calls: string[];
let seq: number;
let active: boolean;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lucid-recovery-"));
  createConversationRecord(root, CONV);
  server = await startServe({ port: 0, rootDir: root });
  dom = new JSDOM("", { url: server.url });
  storage = dom.window.sessionStorage;
  calls = [];
  seq = 0;
  active = true;
});

afterEach(async () => {
  await server.close();
  dom.window.close();
  rmSync(root, { force: true, recursive: true });
});

const post = (body: unknown, token = server.token): Promise<Response> =>
  fetch(`${server.url}/api/conversations/${CONV}/input`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-lucid-token": token },
    method: "POST",
  });

const browser = (
  overrides: Partial<InputRecoveryDeps> = {},
): ReturnType<typeof createInputRecovery> => {
  const token = server.token;
  return createInputRecovery({
    conversationId: CONV,
    fetch: (path, init) => {
      calls.push(String(init.body));
      return fetch(`${server.url}${path}`, init);
    },
    isActive: () => active,
    newId: () => `browser-${++seq}`,
    storage: () => storage,
    token: () => token,
    ...overrides,
  });
};

const inputs = (): readonly { id: string; text: string }[] => {
  const host = openWriter(join(root, CONV));
  try {
    return host.transcript().inputs;
  } finally {
    host.close();
  }
};

const withPanel = async (
  client: ReturnType<typeof browser>,
  exercise: (container: HTMLElement, restored: string[], reloaded: string[]) => Promise<void>,
): Promise<void> => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    document: dom.window.document,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  const restored: string[] = [];
  const reloaded: string[] = [];
  try {
    await act(async () => {
      root.render(
        createElement(InputRecoveryPanel, {
          onReload: () => reloaded.push("reload"),
          onRestore: (request, error) => restored.push(`${error}:${request.body}`),
          recovery: client,
        }),
      );
    });
    await exercise(container, restored, reloaded);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
};

const clickPanel = async (
  container: HTMLElement,
  label: string,
  client?: ReturnType<typeof browser>,
): Promise<void> => {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeDefined();
  const settled =
    client === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            stop();
            reject(new Error("Recovery did not settle"));
          }, 1000);
          const stop = client.subscribe(() => {
            if (client.getSnapshot().kind !== "settled") return;
            clearTimeout(timeout);
            stop();
            resolve();
          });
        });
  await act(async () => {
    button?.click();
    await settled;
  });
};

describe("the recovery controls", () => {
  test("mount is passive; Retry reconciles with the server and shows acceptance", async () => {
    await browser({
      fetch: async () => {
        throw new Error("offline");
      },
    }).begin("doc", NOTE);
    const client = browser();
    await withPanel(client, async (container) => {
      expect(container.textContent).toContain("Bring this back");
      expect(container.querySelector("textarea")).toBeNull();
      expect(calls).toHaveLength(0);
      await clickPanel(container, "Retry", client);
      expect(container.textContent).toContain("Note sent.");
      expect(inputs()).toHaveLength(1);
      await clickPanel(container, "Done");
      expect(container.textContent).toBe("");
    });
  });

  test("401 offers only Reload; it never turns into an automatic retry", async () => {
    const client = browser({ fetch: async () => new Response("unauthorized", { status: 401 }) });
    await client.begin("doc", NOTE);
    await withPanel(client, async (container, _restored, reloaded) => {
      expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(
        ["Reload"],
      );
      await clickPanel(container, "Reload");
      expect(reloaded).toEqual(["reload"]);
      expect(storage.getItem(recoveryKey(CONV))).not.toBeNull();
    });
  });

  test("an explicit refusal returns the original note and source to its editor", async () => {
    await browser({
      fetch: async () => {
        throw new Error("offline");
      },
    }).begin("doc", NOTE);
    await post({ id: "browser-1", text: "different" });
    const client = browser();
    await withPanel(client, async (container, restored) => {
      await clickPanel(container, "Retry", client);
      await clickPanel(container, "Return to note");
      expect(restored).toEqual([`E-COMP-06:${JSON.stringify({ id: "browser-1", text: NOTE })}`]);
      expect(container.textContent).toBe("");
    });
  });

  test("malformed recovery text is inert; discard explicitly explains its limited effect", async () => {
    storage.setItem(
      recoveryKey(CONV),
      JSON.stringify({ body: JSON.stringify({ text: "<script>bad()</script>" }), version: 99 }),
    );
    await withPanel(browser(), async (container) => {
      expect(container.querySelector("script")).toBeNull();
      expect(container.textContent).toContain("<script>bad()</script>");
      expect(container.textContent).toContain("does not cancel an accepted input");
      await clickPanel(container, "Discard recovery data");
      expect(calls).toHaveLength(0);
      expect(storage.getItem(recoveryKey(CONV))).toBeNull();
    });
  });
});

describe("repeat-safe browser admission", () => {
  test("concurrent copies return one receipt and leave one durable input", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => post({ id: "same", text: NOTE })),
    );
    for (const response of responses)
      expect(await response.json()).toEqual({
        inputId: "same",
        noteIndex: 0,
        seq: 1,
        verdict: "accepted",
      });
    expect(inputs()).toHaveLength(1);
    const before = readFileSync(join(root, CONV, "log.ndjson"), "utf8");
    expect((await post({ id: "same", text: "different" })).status).toBe(409);
    expect(readFileSync(join(root, CONV, "log.ndjson"), "utf8")).toBe(before);
  });

  test("a stale open writer catches up before returning the accepted receipt", () => {
    const first = openWriter(join(root, CONV));
    const second = openWriter(join(root, CONV));
    try {
      expect(first.submitInput({ id: "same", text: NOTE }).verdict).toBe("accepted");
      expect(second.submitInput({ id: "same", text: NOTE }).verdict).toBe("accepted");
      expect(second.transcript().inputs).toHaveLength(1);
      expect(second.enqueueInput({ id: "same", mode: "queue", text: NOTE })).toMatchObject({
        issue: "input-id-reused",
        verdict: "refused",
      });
    } finally {
      first.close();
      second.close();
    }
  });

  test("accepted identity wins after application, a newer document, and capacity saturation", async () => {
    const created = createConversationRecord(root, "full");
    const host = openWriter(join(root, "full"));
    try {
      expect(
        host.handleFrame(
          encodeFrame(
            attach({ conversationId: "full", profile: "headless-session", secret: created.secret }),
          ),
        ),
      ).toMatchObject({ verdict: "accepted" });
      for (let i = 0; i < 8; i++) {
        expect(host.submitInput({ id: `in-${i}`, text: NOTE }).verdict).toBe("accepted");
        expect(
          host.handleFrame(
            encodeFrame({ epoch: 1, inputId: `in-${i}`, kind: "disposition", outcome: "applied" }),
          ),
        ).toMatchObject({ verdict: "accepted" });
      }
      host.writeArtifact({
        artifactId: "doc",
        author: "human",
        bytes: "newer",
        contentType: "text/html",
        version: 2,
      });
      expect(host.submitInput({ id: "new", text: NOTE })).toMatchObject({
        issue: "input-queue-full",
        verdict: "refused",
      });
      expect(host.submitInput({ id: "in-0", text: NOTE })).toEqual({
        inputId: "in-0",
        verdict: "accepted",
      });
      expect(host.transcript().inputs).toHaveLength(8);
    } finally {
      host.close();
    }
  });

  test("a refused attempted entry in the durable log is not a receipt", async () => {
    // Synthetic compatibility case: an envelope-valid future input mode,
    // composed here rather than represented as a recorded harness fixture.
    appendFileSync(
      join(root, CONV, "log.ndjson"),
      `${JSON.stringify({ at: 1, input: { id: "attempt", mode: "future-mode", text: "bad" }, src: "input", v: 1 })}\n`,
    );
    expect(await (await post({ id: "attempt", text: NOTE })).json()).toMatchObject({
      inputId: "attempt",
      verdict: "accepted",
    });
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]?.text).toBe(NOTE);
  });

  test("wire-invalid identities, null bodies and over-size text are refused; legacy sends still work", async () => {
    for (const id of [null, 2, "", "x\n", "x".repeat(129)])
      expect((await post({ id, text: NOTE })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect((await post({ id: "long", text: "x".repeat(TEXT_MAX + 1) })).status).toBe(413);
    expect(inputs()).toHaveLength(0);
    const one = await (await post({ text: "legacy" })).json();
    const two = await (await post({ text: "legacy" })).json();
    expect(one.inputId).not.toBe(two.inputId);
    expect(inputs()).toHaveLength(2);
  });
});

describe("same-tab recovery against a running server", () => {
  test("accepted response loss, restart, 401, reload, explicit Retry: one note", async () => {
    const first = browser({
      fetch: async (path, init) => {
        calls.push(String(init.body));
        await fetch(`${server.url}${path}`, init);
        throw new Error("response lost");
      },
    });
    expect(await first.begin("doc", NOTE)).toMatchObject({ kind: "pending", phase: "ready" });
    const original = storage.getItem(recoveryKey(CONV));
    expect(inputs()).toHaveLength(1);
    const stale = browser();
    const port = server.port;
    await server.close();
    server = await startServe({ port, rootDir: root });
    expect(await stale.retry()).toMatchObject({ kind: "pending", phase: "reload" });
    expect(storage.getItem(recoveryKey(CONV))).toBe(original);
    const reloaded = browser();
    expect(calls).toHaveLength(2); // Constructing the reloaded client did not send.
    expect(await reloaded.retry()).toMatchObject({
      kind: "settled",
      outcome: { kind: "accepted" },
    });
    expect(new Set(calls).size).toBe(1);
    expect(storage.getItem(recoveryKey(CONV))).toBeNull();
    expect(inputs()).toHaveLength(1);
  });

  test("a request which never arrived is recovered with its original identity", async () => {
    const offline = browser({
      fetch: async () => {
        throw new Error("offline");
      },
    });
    await offline.begin("doc", NOTE);
    expect(inputs()).toHaveLength(0);
    expect(await browser().retry()).toMatchObject({
      kind: "settled",
      outcome: { kind: "accepted", request: { id: "browser-1" } },
    });
    expect(inputs()).toHaveLength(1);
  });

  test("copied tab entries reconcile concurrently rather than create fresh sends", async () => {
    await browser({
      fetch: async () => {
        throw new Error("offline");
      },
    }).begin("doc", NOTE);
    const copy = new JSDOM("", { url: server.url });
    copy.window.sessionStorage.setItem(recoveryKey(CONV), storage.getItem(recoveryKey(CONV)) ?? "");
    try {
      await Promise.all([
        browser().retry(),
        browser({ storage: () => copy.window.sessionStorage }).retry(),
      ]);
      expect(inputs()).toHaveLength(1);
    } finally {
      copy.window.close();
    }
  });

  test("refused recovery restores the exact draft, including source evidence", async () => {
    await browser({
      fetch: async () => {
        throw new Error("offline");
      },
    }).begin("doc", NOTE);
    await post({ id: "browser-1", text: "already occupied" });
    const result = await browser().retry();
    expect(result).toMatchObject({
      kind: "settled",
      outcome: {
        error: "E-COMP-06",
        kind: "refused",
        request: { body: JSON.stringify({ id: "browser-1", text: NOTE }) },
      },
    });
    expect(storage.getItem(recoveryKey(CONV))).toBeNull();
    expect(inputs()).toHaveLength(1);
  });

  test("unresolved and in-flight sends block replacements; closed conversations do not retry", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = browser({
      fetch: async () => {
        calls.push("attempt");
        await gate;
        throw new Error("offline");
      },
    });
    const first = client.begin("doc", NOTE);
    await client.begin("doc", "replacement");
    await client.retry();
    expect(calls).toHaveLength(1);
    release?.();
    await first;
    active = false;
    await client.retry();
    await client.begin("doc", "replacement");
    expect(calls).toHaveLength(1);
    expect(seq).toBe(1);
  });
});

describe("browser storage and uncertain replies", () => {
  test.each(["getter", "write", "readback"])(
    "%s failure prevents the first network attempt",
    async (failure) => {
      const client = browser({
        storage: () => {
          if (failure === "getter") throw new Error("denied");
          return {
            getItem: (key) =>
              failure === "readback" && storage.getItem(key) !== null
                ? "different"
                : storage.getItem(key),
            removeItem: (key) => storage.removeItem(key),
            setItem: (key, value) => {
              if (failure === "write") throw new Error("quota");
              storage.setItem(key, value);
            },
          };
        },
      });
      expect(await client.begin("doc", NOTE)).toMatchObject({ kind: "storage-error" });
      expect(calls).toHaveLength(0);
      expect(inputs()).toHaveLength(0);
    },
  );

  test("cleanup failure preserves the known outcome; reload alone cannot resend", async () => {
    let fail = true;
    const client = browser({
      storage: () => ({
        getItem: (key) => storage.getItem(key),
        removeItem: (key) => {
          if (fail) throw new Error("denied");
          storage.removeItem(key);
        },
        setItem: (key, value) => storage.setItem(key, value),
      }),
    });
    expect(await client.begin("doc", NOTE)).toMatchObject({
      kind: "storage-error",
      outcome: { kind: "accepted" },
    });
    await client.begin("doc", "another");
    browser();
    expect(calls).toHaveLength(1);
    fail = false;
    client.refreshStorage();
    expect(client.getSnapshot()).toMatchObject({ kind: "settled", outcome: { kind: "accepted" } });
    expect(storage.getItem(recoveryKey(CONV))).toBeNull();
  });

  test("malformed entries preserve readable text; explicit discard sends nothing", async () => {
    storage.setItem(
      recoveryKey(CONV),
      JSON.stringify({ body: JSON.stringify({ text: "<script>bad()</script>" }), version: 99 }),
    );
    const client = browser();
    expect(client.getSnapshot()).toEqual({
      code: "E-COMP-08",
      kind: "invalid",
      text: "<script>bad()</script>",
    });
    await client.begin("doc", NOTE);
    await client.retry();
    expect(calls).toHaveLength(0);
    client.discardInvalid();
    expect(client.getSnapshot()).toEqual({ kind: "idle" });
    expect(storage.getItem(recoveryKey(CONV))).toBeNull();
  });

  test("another conversation's stored entry is never submitted", async () => {
    await browser({
      fetch: async () => {
        throw new Error("offline");
      },
    }).begin("doc", NOTE);
    const raw = storage.getItem(recoveryKey(CONV)) ?? "";
    storage.setItem(
      recoveryKey(CONV),
      raw.replace('"conversationId":"recovery"', '"conversationId":"elsewhere"'),
    );
    expect(browser().getSnapshot().kind).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  test.each(["wrong-id", "bad-json", "missing-verdict", "missing-note-index", "server-error"])(
    "%s remains uncertain",
    async (reply) => {
      const response =
        reply === "bad-json"
          ? new Response("{")
          : Response.json(
              {
                error: "temporary",
                inputId: reply === "wrong-id" ? "other" : "browser-1",
                ...(reply === "missing-note-index" ? {} : { noteIndex: 0 }),
                ...(reply === "missing-verdict"
                  ? {}
                  : { verdict: reply === "server-error" ? "refused" : "accepted" }),
              },
              { status: reply === "server-error" ? 503 : 200 },
            );
      const client = browser({ fetch: async () => response });
      expect(await client.begin("doc", NOTE)).toMatchObject({ kind: "pending", phase: "ready" });
      expect(storage.getItem(recoveryKey(CONV))).not.toBeNull();
    },
  );
});
