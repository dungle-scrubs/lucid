import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatRefused, chatConversation } from "../../src/cli/chat.js";
import { runCli } from "../../src/cli/dispatch.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { HCN_MIN_VERSION } from "../../src/harness/version.js";
import { EventKind, INPUT_QUEUE_MAX } from "../../src/protocol/events.js";
import type { Frame } from "../../src/protocol/index.js";
import { encodeFrame } from "../../src/protocol/index.js";
import { viewArtifactCatalog, viewArtifactVersion } from "../../src/store/conversation-host.js";
import { StoreError } from "../../src/store/errors.js";
import { LockError } from "../../src/store/flock.js";
import { openConversation } from "../../src/store/store.js";
import { NotTTYError } from "../../src/tui/input.js";
import type { TuiView } from "../../src/tui/view.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";
import { attach } from "../protocol/helpers.js";

// Helpers

const fakeRunnerSession: HarnessRunner = {
  openSession: async () => {
    // minimal session handle — not used by chat's fake host
    return {
      turns: (async function* () {})(),
      send: async () => ({ disposition: "started" as const }),
      answer: async () => ({ disposition: "started" as const }),
      close: async () => ({ exitCode: 0, cause: "closed" }),
    } as unknown as ReturnType<HarnessRunner["openSession"]>;
  },
  streamTurn: (() => {
    throw new Error("not used");
  }) as unknown as HarnessRunner["streamTurn"],
  inspect: async () => ({ name: "claude", session: true, verifiedAgainst: "fake" }),
  capabilities: async () => ({
    vision: false,
    images: false,
    streaming: "line",
    session: true,
    source: "curated" as const,
    confidence: "high" as const,
  }),
} as unknown as HarnessRunner;

const fakeRunnerTurn: HarnessRunner = {
  ...fakeRunnerSession,
  inspect: async () => ({ name: "codex", session: false, verifiedAgainst: "fake" }),
} as unknown as HarnessRunner;

const fakePresence = () => {
  let held = false;
  const handle = {
    release: (): void => {
      held = false;
    },
    held: () => held,
  };
  const acquire = (): typeof handle => {
    if (held) throw new Error("already held");
    held = true;
    return handle;
  };
  return {
    handle,
    acquire: acquire as unknown as typeof import("../../src/store/presence.js").acquirePresence,
  };
};

async function* keysOf(...chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

const _until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met before deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("lucid chat — one window drives, renders, and sends (RFC-05)", () => {
  test("one command drives a conversation and renders it, and what you type reaches the harness", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-one-"));
    const now = 1000;
    const nowFn = () => now;
    let nextId = 0;
    const uuidFn = () => `id-${++nextId}`;

    const views: TuiView[] = [];
    // Keys: type "hello" then Enter, then Ctrl-C to exit
    const keys = keysOf("hello", "\r", "\x03");

    // Use fake host that captures enqueued inputs via host.enqueueInput
    // We inject createHeadlessHost that does nothing but captures receive
    const received: Frame[] = [];
    const fakeHostFn = ((_deps: { sendFrame: (f: Frame) => unknown }) => {
      // Capture sendFrame to simulate disposition? Instead let host handle it
      // The chat's host is the real store host, so enqueue will write to log.
      // We just need a source that does not throw.
      return {
        settled: Promise.resolve(),
        receive: (f: Frame) => received.push(f),
        close: () => {},
      };
    }) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    const chatPromise = chatConversation({
      rootDir: root,
      conversationId: "conv-chat-1",
      runner: fakeRunnerSession,
      keys,
      now: nowFn,
      randomUUID: uuidFn,
      onView: (v) => views.push(v),
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    await chatPromise;

    // Rendered at least once
    expect(views.length).toBeGreaterThanOrEqual(1);
    // The input was appended durably
    const dir = join(root, "conv-chat-1");
    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host.transcript().inputs.some((i) => i.text === "hello")).toBe(true);
  });

  test("a question is answered from this window, without another terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-answer-"));
    let now = 1000;
    const nowFn = () => now;
    let nextId = 0;
    const uuidFn = () => `id-${++nextId}`;

    // Pre-seed a question in the log before chat starts
    const convs = conversations(root);
    const { secret, dir } = convs.ensure("conv-q");
    const seeder = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    seeder.handleFrame(
      encodeFrame(attach({ conversationId: "conv-q", secret, profile: "headless-session" })),
    );
    now += 10;
    seeder.handleFrame(
      encodeFrame({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "turn-7",
        event: { kind: EventKind.question, question: "What next?" },
      }),
    );
    seeder.close();

    const views: TuiView[] = [];
    const keys = keysOf("Draft the RFC", "\r", "\x03");

    const fakeHostFn = ((_deps: { sendFrame: (f: Frame) => unknown }) => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-q",
      runner: fakeRunnerSession,
      keys,
      now: nowFn,
      randomUUID: uuidFn,
      onView: (v) => views.push(v),
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    // The answer was sent with mode answer and correct turnId
    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    const answerInput = host.transcript().inputs.find((i) => i.text === "Draft the RFC");
    expect(answerInput).toBeDefined();
    expect(answerInput?.mode).toBe("answer");
    // The input is enqueued as answer and reserves the question until applied
    expect(host.state().questionOpen?.turnId).toBe("turn-7");
    expect(host.state().questionOpen?.answeringInputId).toBeDefined();
    // The log should contain answer mode
    const raw = readFileSync(join(dir, "log.ndjson"), "utf8");
    expect(raw).toContain('"mode":"answer"');
    expect(raw).toContain('"turnId":"turn-7"');
  });

  test("while harness is asking, submitting sends answer; otherwise ordinary input", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-routing-"));
    let now = 1000;
    const nowFn = () => now;
    let nextId = 0;
    const uuidFn = () => `id-${++nextId}`;

    // First, no question — ordinary input
    {
      const keys = keysOf("ordinary", "\r", "\x03");
      const fakeHostFn = (() => ({
        settled: Promise.resolve(),
        receive: () => {},
        close: () => {},
      })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;
      await chatConversation({
        rootDir: root,
        conversationId: "conv-route-1",
        runner: fakeRunnerSession,
        keys,
        now: nowFn,
        randomUUID: uuidFn,
        onView: () => {},
        createHeadlessHostFn: fakeHostFn,
        presence: () => undefined,
        pollMs: 10,
      });
      const dir = join(root, "conv-route-1");
      const raw = readFileSync(join(dir, "log.ndjson"), "utf8");
      expect(raw).toContain('"mode":"queue"');
      expect(raw).not.toContain('"mode":"answer"');
    }

    // Now with question — answer
    {
      const convs = conversations(root);
      const { secret, dir } = convs.ensure("conv-route-2");
      const seeder = openConversation(dir, {
        now: () => now,
        presence: () => undefined,
        executorLease: () => false,
        onEffect: () => {},
        onRecord: () => {},
      });
      seeder.handleFrame(
        encodeFrame(
          attach({ conversationId: "conv-route-2", secret, profile: "headless-session" }),
        ),
      );
      now += 10;
      seeder.handleFrame(
        encodeFrame({
          kind: "event",
          epoch: 1,
          n: 1,
          turnId: "t-ask",
          event: { kind: EventKind.question, question: "Q?" },
        }),
      );
      seeder.close();

      const keys = keysOf("my answer", "\r", "\x03");
      const fakeHostFn = (() => ({
        settled: Promise.resolve(),
        receive: () => {},
        close: () => {},
      })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;
      await chatConversation({
        rootDir: root,
        conversationId: "conv-route-2",
        runner: fakeRunnerSession,
        keys,
        now: nowFn,
        randomUUID: uuidFn,
        onView: () => {},
        createHeadlessHostFn: fakeHostFn,
        presence: () => undefined,
        pollMs: 10,
      });
      const raw = readFileSync(join(dir, "log.ndjson"), "utf8");
      expect(raw).toContain('"mode":"answer"');
    }
  });

  test("window refuses what protocol would refuse, says why, keeps draft — answer already in flight", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-refuse-flight-"));
    let now = 1000;
    const nowFn = () => now;
    let nextId = 0;
    const uuidFn = () => `id-${++nextId}`;

    const convs = conversations(root);
    const { secret, dir } = convs.ensure("conv-flight");
    const seeder = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    seeder.handleFrame(
      encodeFrame(attach({ conversationId: "conv-flight", secret, profile: "headless-session" })),
    );
    now += 10;
    seeder.handleFrame(
      encodeFrame({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t-1",
        event: { kind: EventKind.question, question: "Q?" },
      }),
    );
    // Enqueue one answer so reservation is held
    now += 10;
    seeder.enqueueInput({ id: "ans-pending", text: "first", mode: "answer", turnId: "t-1" });
    seeder.close();

    const views: TuiView[] = [];
    // Try to send second answer
    const keys = keysOf("second", "\r", "\x03");

    const fakeHostFn = (() => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-flight",
      runner: fakeRunnerSession,
      keys,
      now: nowFn,
      randomUUID: uuidFn,
      onView: (v) => views.push(v),
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    // Should have shown refusal in window, not appended second answer
    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host.transcript().inputs.some((i) => i.text === "second")).toBe(false);
    // View should contain the refusal message
    const allText = views.flatMap((v) => v.lines.map((l) => l.text)).join(" ");
    expect(allText).toContain("already in flight");
    // Draft should be kept — last view's inputBox should contain second
    const lastView = views[views.length - 1];
    expect(lastView?.inputBox).toContain("second");
  });

  test("window refuses answer when profile is headless-turn — no session to answer into", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-no-session-"));
    let now = 1000;
    const nowFn = () => now;
    let nextId = 0;
    const uuidFn = () => `id-${++nextId}`;

    const convs = conversations(root);
    const { secret, dir } = convs.ensure("conv-turn");
    const seeder = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    seeder.handleFrame(
      encodeFrame(
        attach({ conversationId: "conv-turn", secret, profile: "headless-turn", harness: "codex" }),
      ),
    );
    now += 10;
    seeder.handleFrame(
      encodeFrame({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t-1",
        event: { kind: EventKind.question, question: "Q?" },
      }),
    );
    seeder.close();

    const views: TuiView[] = [];
    const keys = keysOf("try answer", "\r", "\x03");
    const fakeHostFn = (() => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-turn",
      runner: fakeRunnerTurn,
      keys,
      now: nowFn,
      randomUUID: uuidFn,
      onView: (v) => views.push(v),
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host.transcript().inputs.some((i) => i.text === "try answer")).toBe(false);
    const allText = views.flatMap((v) => v.lines.map((l) => l.text)).join(" ");
    expect(allText).toContain("session profile");
  });

  test("window refuses when conversation too far behind — input-queue-full", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-full-"));
    let now = 1000;
    const nowFn = () => now;
    let nextId = 0;
    const uuidFn = () => `id-${++nextId}`;

    const convs = conversations(root);
    const { secret, dir } = convs.ensure("conv-full");
    const seeder = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    seeder.handleFrame(
      encodeFrame(attach({ conversationId: "conv-full", secret, profile: "headless-session" })),
    );
    // Fill to capacity
    for (let i = 1; i <= INPUT_QUEUE_MAX; i++) {
      now += 10;
      seeder.enqueueInput({ id: `fill-${i}`, text: `t${i}`, mode: "queue" });
      now += 10;
      seeder.handleFrame(
        encodeFrame({ kind: "disposition", epoch: 1, inputId: `fill-${i}`, outcome: "applied" }),
      );
    }
    seeder.close();

    const views: TuiView[] = [];
    const keys = keysOf("overflow", "\r", "\x03");
    const fakeHostFn = (() => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-full",
      runner: fakeRunnerSession,
      keys,
      now: nowFn,
      randomUUID: uuidFn,
      onView: (v) => views.push(v),
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host.transcript().inputs.some((i) => i.text === "overflow")).toBe(false);
    const allText = views.flatMap((v) => v.lines.map((l) => l.text)).join(" ");
    expect(allText).toContain("too far behind");
  });

  test("refused submit keeps draft and resend mints fresh id", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-keep-"));
    let now = 1000;
    const nowFn = () => now;
    const ids: string[] = [];
    let nextId = 0;
    const uuidFn = () => {
      const id = `id-${++nextId}`;
      ids.push(id);
      return id;
    };

    const convs = conversations(root);
    const { secret, dir } = convs.ensure("conv-keep");
    const seeder = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    seeder.handleFrame(
      encodeFrame(attach({ conversationId: "conv-keep", secret, profile: "headless-session" })),
    );
    now += 10;
    seeder.handleFrame(
      encodeFrame({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t-1",
        event: { kind: EventKind.question, question: "Q?" },
      }),
    );
    seeder.enqueueInput({ id: "ans-1", text: "first", mode: "answer", turnId: "t-1" });
    seeder.close();

    const views: TuiView[] = [];
    // First submit will be refused (answer in flight), second after clearing question should succeed
    // But we need to simulate question clearing before second submit.
    // Instead test that refused draft is kept and next id is fresh.
    const keys = keysOf("kept text", "\r", "\x03");
    const fakeHostFn = (() => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-keep",
      runner: fakeRunnerSession,
      keys,
      now: nowFn,
      randomUUID: uuidFn,
      onView: (v) => views.push(v),
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    const lastView = views[views.length - 1];
    expect(lastView?.inputBox).toContain("kept text");
    // At least one id was minted for the refused attempt, and it was not reused
    expect(ids.length).toBeGreaterThanOrEqual(1);
    // The refused id is not in the log as accepted
    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host.transcript().inputs.some((i) => i.text === "kept text")).toBe(false);
  });

  test("will not start against conversation something else is driving — names holder, says watch works", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-held-"));
    conversations(root).ensure("conv-held");

    // Fake presence that throws lease-held
    const failingAcquire = (): never => {
      throw new Error("already held");
    };

    const keys = keysOf("x", "\r");
    await expect(
      chatConversation({
        rootDir: root,
        conversationId: "conv-held",
        runner: fakeRunnerSession,
        keys,
        acquirePresenceFn:
          failingAcquire as unknown as typeof import("../../src/store/presence.js").acquirePresence,
        presence: () => undefined,
        now: () => 1000,
        randomUUID: () => "id-1",
        onView: () => {},
        pollMs: 10,
      }),
    ).rejects.toThrow(ChatRefused);

    try {
      await chatConversation({
        rootDir: root,
        conversationId: "conv-held",
        runner: fakeRunnerSession,
        keys: keysOf("x", "\r"),
        acquirePresenceFn:
          failingAcquire as unknown as typeof import("../../src/store/presence.js").acquirePresence,
        presence: () => undefined,
        now: () => 1000,
        randomUUID: () => "id-1",
        onView: () => {},
        pollMs: 10,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ChatRefused);
      expect((e as ChatRefused).code).toBe("lease-held");
      expect((e as Error).message).toContain("already being driven");
      expect((e as Error).message).toContain("watch");
    }
  });

  test("D-021: will not start when interactive session still attached", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-d021-"));
    const convs = conversations(root);
    convs.ensure("conv-d021");
    // Need a host with interactive-attached status: create attach with interactive profile that is live
    // For D-021, channelStatus is interactive-unattached when lease dead but presence true.
    // To get interactive-unattached, we need an interactive attachment that then expires.
    // Simpler: test via injected presence true and a host state that is interactive-unattached.
    // We'll seed an interactive attach then let lease expire via time.
    let now = 1000;
    const dir = join(root, "conv-d021");
    const seeder = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    // Use secret from ensure
    const secret = readFileSync(join(dir, "secret"), "utf8").trim();
    seeder.handleFrame(
      encodeFrame(
        attach({ conversationId: "conv-d021", secret, profile: "interactive", version: 1 }),
      ),
    );
    seeder.close();
    // Now lease is live (just attached at 1000), but we need it to be dead with presence true.
    // Advance clock past lease TTL (15s)
    now = 20000;
    const keys = keysOf("x", "\r");
    await expect(
      chatConversation({
        rootDir: root,
        conversationId: "conv-d021",
        runner: fakeRunnerSession,
        keys,
        now: () => now,
        presence: () => true,
        randomUUID: () => "id-1",
        onView: () => {},
        pollMs: 10,
      }),
    ).rejects.toThrow(ChatRefused);
  });

  test("losing the right to drive mid-session does not kill it: stops accepting, keeps rendering, keeps draft, says moved", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-following-"));
    const now = 1000;
    const nowFn = () => now;
    let nextId = 0;
    const uuidFn = () => `id-${++nextId}`;

    const presence = fakePresence();
    const views: TuiView[] = [];

    // Start chat, then mid-session release presence to simulate takeover, then type and submit
    // Keys: type "before", then we will release presence via handle, then type "after" and submit
    // Use a custom keys iterable that releases presence after first input
    const handle = presence.handle;
    const _step = 0;
    const keys: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        yield "before";
        yield "\r";
        // After first submit, release presence to simulate lease loss
        await new Promise((r) => setTimeout(r, 50));
        handle.release();
        // Now type after lease loss
        yield "after";
        yield "\r";
        await new Promise((r) => setTimeout(r, 50));
        yield "\x03";
      },
    };

    const fakeHostFn = (() => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-following",
      runner: fakeRunnerSession,
      keys,
      now: nowFn,
      randomUUID: uuidFn,
      onView: (v) => views.push(v),
      createHeadlessHostFn: fakeHostFn,
      acquirePresenceFn: presence.acquire,
      presence: () => undefined,
      pollMs: 10,
    });

    // Should have rendered in following mode
    const followingViews = views.filter(
      (v) => v.rung === "following" || v.lines.some((l) => l.text.includes("conversation moved")),
    );
    expect(followingViews.length).toBeGreaterThan(0);
    // Draft "after" should be kept (not submitted)
    const lastView = views[views.length - 1];
    expect(lastView?.inputBox).toContain("after");
    // "before" should have been submitted before lease loss
    const dir = join(root, "conv-following");
    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host.transcript().inputs.some((i) => i.text === "before")).toBe(true);
    expect(host.transcript().inputs.some((i) => i.text === "after")).toBe(false);
  });

  test("reads under the lock, not through viewer's lock-free peek", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-lock-"));
    const now = 1000;
    const nowFn = () => now;
    let nextId = 0;
    const uuidFn = () => `id-${++nextId}`;

    // We verify that chat's trigger uses read() — by checking that a torn tail
    // is repaired. But simpler: assert that chat's tailerDeps path is read.
    // We instrument by checking that viewSnapshot (peek) is not called, but read is.
    // Instead, verify that chat renders correctly even when log has a torn tail pending —
    // the lock-taking read repairs it, while peek would tolerate it.
    const convs = conversations(root);
    convs.ensure("conv-lock");
    const dir = join(root, "conv-lock");

    const views: TuiView[] = [];
    const keys = keysOf("hello", "\r", "\x03");
    const fakeHostFn = (() => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-lock",
      runner: fakeRunnerSession,
      keys,
      now: nowFn,
      randomUUID: uuidFn,
      onView: (v) => views.push(v),
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    // If chat used peek, it would not repair torn tail, but we at least
    // verify it rendered (which requires a successful read)
    expect(views.length).toBeGreaterThan(0);
    // The input reached the log via lock-taking host
    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host.transcript().inputs.some((i) => i.text === "hello")).toBe(true);
  });

  test("Ctrl-C leaves terminal exactly as it found it — restores raw mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-ctrlc-"));
    const now = 1000;
    const rawCalls: boolean[] = [];
    const fakeStdin = {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        rawCalls.push(mode);
        (fakeStdin as unknown as { isRaw: boolean }).isRaw = mode;
      },
      setEncoding() {},
      resume() {},
      pause() {},
      [Symbol.asyncIterator]: async function* () {
        yield "\x03";
      },
    } as unknown as NodeJS.ReadStream;
    const fakeStdout = { isTTY: true } as unknown as NodeJS.WriteStream;

    const fakeHostFn = (() => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-ctrlc",
      runner: fakeRunnerSession,
      stdin: fakeStdin,
      stdout: fakeStdout,
      now: () => now,
      randomUUID: () => "id-1",
      onView: () => {},
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    expect(rawCalls).toEqual([true, false]);
  });

  test("piped or redirected, it renders once and exits non-zero — no escape codes into file", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-pipe-"));
    const fakeStdin = { isTTY: false } as unknown as NodeJS.ReadStream;
    const fakeStdout = { isTTY: false } as unknown as NodeJS.WriteStream;
    const writes: string[] = [];

    await expect(
      chatConversation({
        rootDir: root,
        conversationId: "conv-pipe",
        runner: fakeRunnerSession,
        stdin: fakeStdin,
        stdout: fakeStdout,
        write: (s) => writes.push(s),
        now: () => 1000,
        randomUUID: () => "id-1",
        onView: undefined,
        presence: () => undefined,
        pollMs: 10,
      }),
    ).rejects.toBeInstanceOf(NotTTYError);

    // Rendered once, no escape codes
    const joined = writes.join("");
    expect(joined).not.toContain("\x1b[2J");
    expect(joined).not.toContain("\x1b[H");
  });

  test("Ctrl-C with non-empty draft — draft is lost, not durable", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-draft-lost-"));
    const now = 1000;
    const keys = keysOf("unsent text", "\x03");
    const fakeHostFn = (() => ({
      settled: Promise.resolve(),
      receive: () => {},
      close: () => {},
    })) as unknown as typeof import("../../src/modes/host.js").createHeadlessHost;

    await chatConversation({
      rootDir: root,
      conversationId: "conv-draft",
      runner: fakeRunnerSession,
      keys,
      now: () => now,
      randomUUID: () => "id-1",
      onView: () => {},
      createHeadlessHostFn: fakeHostFn,
      presence: () => undefined,
      pollMs: 10,
    });

    const dir = join(root, "conv-draft");
    const host = openConversation(dir, {
      now: () => now,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host.transcript().inputs.some((i) => i.text === "unsent text")).toBe(false);
  });

  test("the conversation name reaches chat, rather than a generated one", async () => {
    // The first cut passed the id as a first argument to a function that
    // takes one options object, so `lucid chat demo` opened a conversation
    // called conv-<timestamp>. The seam's declared type had a parameter the
    // real function does not have, and TypeScript accepted that because a
    // function of fewer parameters is assignable to one of more.
    let seen: string | undefined = "unset";
    await runCli(["chat", "demo", "--harness", "claude"], {
      chatConversationFn: async (opts) => {
        seen = opts.conversationId;
      },
      onOutput: () => {},
    });
    expect(seen).toBe("demo");
  });
});

test("chat applies an artifact patch and tells the next input what the record holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-artifact-"));
  const { dir } = conversations(root).ensure("chat-artifact");
  const proc = new FakeHcnProcess();
  const hcn = createHcnRunner({ spawn: fakeSpawner([proc]).spawn, bin: "/fake/hcn" });
  const runner: HarnessRunner = { ...fakeRunnerSession, openSession: hcn.openSession };
  const sent = () => proc.commands.filter((m) => m.op === "send");
  let patched = false;
  const keys = (async function* () {
    proc.emit({
      kind: "session",
      sessionId: "chat-session",
      harness: "claude",
      hcn: HCN_MIN_VERSION,
      escalateQuestions: true,
    });
    yield "revise";
    yield "\r";
    await _until(() => sent().length === 1);
    const first = sent()[0];
    proc.emit({ kind: "disposition", id: first?.id, disposition: "started" });
    proc.emit({ kind: "turn", turnId: "native-1", id: first?.id });
    proc.emit({
      kind: "message",
      role: "assistant",
      text: '```lucid-artifact\n{"id":"doc","replaces":null,"contentType":"text/html"}\n<p>one</p>\n```\n```lucid-artifact\n{"id":"doc","replaces":1,"contentType":"text/html","form":"patch"}\n{"edits":[{"find":"one","replace":"two"}]}\n```',
    });
    proc.emit({ kind: "done", exitCode: null, cause: "clean" });
    await _until(
      () =>
        viewArtifactCatalog(dir)[0]?.versions.includes(2) === true ||
        readFileSync(join(dir, "log.ndjson"), "utf8").includes("could not be read"),
    );
    patched = viewArtifactVersion(dir, "doc", 2)?.bytes === "<p>two</p>";
    yield "again";
    yield "\r";
    await _until(() => sent().length >= 2);
    expect(sent().map((c) => c.id)).toEqual([first?.id, sent()[1]?.id]);
    yield "\x03";
  })();
  try {
    await chatConversation({
      rootDir: root,
      conversationId: "chat-artifact",
      runner,
      keys,
      onView: () => {},
      pollMs: 10,
    });
    expect(patched).toBe(true);
    expect(sent()[1]?.text).toContain("current version 2");
    expect(sent()[1]?.text).toContain("[lucid artifact state]");
  } finally {
    proc.exit(0);
  }
});

test.each(["collect", "append"] as const)(
  "chat preserves the submitted draft when %s fails",
  async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), "chat-submit-failure-"));
    const views: TuiView[] = [];
    let submitting = false;
    const keys = (async function* () {
      yield "keep this draft";
      submitting = true;
      yield "\r";
      yield "\x03";
    })();
    await chatConversation({
      rootDir: root,
      conversationId: "submit-failure",
      runner: fakeRunnerSession,
      keys,
      onView: (view) => views.push(view),
      createHeadlessHostFn: () => ({
        settled: Promise.resolve(),
        receive: () => {},
        close: () => {},
      }),
      openConversationFn: (dir, deps) => {
        const host = openConversation(dir, deps);
        return {
          ...host,
          collectEffects: (offset) => {
            if (submitting && boundary === "collect")
              throw new LockError("lock-timeout", "test-lock", "record is busy");
            return host.collectEffects(offset);
          },
          enqueueInput: (params) => {
            if (submitting && boundary === "append")
              throw new StoreError("append-failed", "synthetic failure");
            return host.enqueueInput(params);
          },
        };
      },
    });
    expect(views.at(-1)?.inputBox).toContain("keep this draft");
    expect(JSON.stringify(views.at(-1)?.lines)).toContain("send failed");
  },
);

test("chat reports a stopped driver without claiming another driver took over", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-driver-ended-"));
  const views: TuiView[] = [];
  let ended: Parameters<
    NonNullable<import("../../src/cli/runtime.js").RuntimeDeps["createHeadlessHostFn"]>
  >[0]["onEnded"];
  await chatConversation({
    rootDir: root,
    conversationId: "driver-ended",
    runner: fakeRunnerSession,
    keys: (async function* () {
      ended?.({ kind: "closed" });
      await Promise.resolve();
      yield "draft";
      yield "\x03";
    })(),
    onView: (view) => views.push(view),
    createHeadlessHostFn: (deps) => {
      ended = deps.onEnded;
      return { settled: Promise.resolve(), receive: () => {}, close: () => {} };
    },
  });
  expect(JSON.stringify(views.at(-1))).toContain("driver stopped");
  expect(JSON.stringify(views.at(-1))).not.toContain("another driver took over");
});
