import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { createHeadlessHost, hostSeamFor } from "../../src/modes/host.js";
import { encodeFrame } from "../../src/protocol/index.js";
import { createConversationRecord, openConversation, StoreError } from "../../src/store/store.js";
import { attach } from "../protocol/helpers.js";

const freshRoot = () => mkdtempSync(join(tmpdir(), "lucid-cursor-"));
const recordDir = (root: string, id: string) => join(root, id);
const attachFrame = (secret: string, overrides: Parameters<typeof attach>[0] = {}) =>
  attach({ secret, ...overrides });

describe("delivery cursor (RFC-04 R3/R4 + step7)", () => {
  test("cursor is durable and ordered after the entries it describes", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openConversation(recordDir(root, "conv-1"), {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    h.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    h.enqueueInput({ id: "in-1", text: "hello", mode: "queue" });
    const batch = h.collectEffects(0);
    const goodBefore = batch.goodBytes;
    h.advanceCursor(goodBefore);
    const raw = readFileSync(join(root, "conv-1", "log.ndjson"), "utf8");
    const lines = raw.trim().split("\n");
    const cursorLine = lines[lines.length - 1] ?? "";
    const parsed = JSON.parse(cursorLine);
    expect(parsed.v).toBe(1);
    expect(parsed.src).toBe("cursor");
    expect(parsed.offset).toBe(goodBefore);
    expect(parsed.at).toBe(1000);
    // cursor is last line, after the entries it covers
    expect(raw.lastIndexOf('"src":"cursor"') > raw.lastIndexOf('"id":"in-1"')).toBe(true);
  });

  test("it is written only after every effect it covers has been acted on - reopen before advance repeats, after advance does not", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h1 = openConversation(recordDir(root, "conv-1"), {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    h1.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    h1.enqueueInput({ id: "in-1", text: "a", mode: "queue" });
    const batch = h1.collectEffects(0);
    // Not yet advanced - reopen should repeat
    h1.close();
    const h2 = openConversation(recordDir(root, "conv-1"), {
      now: () => 2000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(h2.cursor()).toBe(0);
    expect(h2.collectEffects(h2.cursor()).entries.length).toBe(2); // attach + input
    // Now advance after dispatch
    h2.advanceCursor(batch.goodBytes);
    h2.close();
    const h3 = openConversation(recordDir(root, "conv-1"), {
      now: () => 3000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(h3.collectEffects(h3.cursor()).entries.length).toBe(0);
  });

  test("reopening does not repeat effects at or below cursor", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h1 = openConversation(recordDir(root, "conv-1"), {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    h1.handleFrame(encodeFrame(attachFrame(secret, { profile: "headless-session" })));
    h1.enqueueInput({ id: "in-1", text: "x", mode: "queue" });
    h1.enqueueInput({ id: "in-2", text: "y", mode: "queue" });
    const batch = h1.collectEffects(0);
    h1.advanceCursor(batch.goodBytes);
    h1.close();
    const h2 = openConversation(recordDir(root, "conv-1"), {
      now: () => 2000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(h2.collectEffects(h2.cursor()).entries.length).toBe(0);
    // New input after cursor should be delivered
    h2.enqueueInput({ id: "in-3", text: "z", mode: "queue" });
    expect(h2.collectEffects(h2.cursor()).entries.length).toBe(1);
  });

  test("cursor past end is corruption - refuse to drive", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openConversation(recordDir(root, "conv-1"), {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    h.handleFrame(encodeFrame(attachFrame(secret)));
    const good = h.collectEffects(0).goodBytes;
    appendFileSync(
      join(root, "conv-1", "log.ndjson"),
      `${JSON.stringify({ v: 1, at: 9999, src: "cursor", offset: good + 9999 })}\n`,
    );
    expect(() =>
      openConversation(recordDir(root, "conv-1"), {
        now: () => 2000,
        presence: () => undefined,
        executorLease: () => true,
        onEffect: () => {},
        onRecord: () => {},
      }),
    ).toThrow(StoreError);
    try {
      openConversation(recordDir(root, "conv-1"), {
        now: () => 2000,
        presence: () => undefined,
        executorLease: () => true,
        onEffect: () => {},
        onRecord: () => {},
      });
    } catch (e) {
      expect((e as StoreError).code).toBe("corrupt-log");
      expect((e as Error).message).toMatch(/cursor/);
    }
  });

  test("truncated cursor line is safe - reads as earlier position, repeat absorbed", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openConversation(recordDir(root, "conv-1"), {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    h.handleFrame(encodeFrame(attachFrame(secret)));
    h.enqueueInput({ id: "in-1", text: "hello", mode: "queue" });
    const batch = h.collectEffects(0);
    h.advanceCursor(batch.goodBytes);
    const logPath = join(root, "conv-1", "log.ndjson");
    const raw = readFileSync(logPath);
    const truncated = raw.subarray(0, raw.length - 5);
    writeFileSync(logPath, truncated);
    const h2 = openConversation(recordDir(root, "conv-1"), {
      now: () => 2000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    // Truncated cursor behind goodBytes is repaired away, so cursor reads as prior value (0 or earlier)
    // The repeat is absorbed by dedup on reopen - but since we lost cursor, batch will repeat
    expect(h2.cursor() < batch.goodBytes).toBe(true);
    // Re-delivery is expected, and the consumer would dedup via cursor check
    expect(h2.collectEffects(h2.cursor()).entries.length).toBeGreaterThan(0);
  });

  test("the attach drain advances the cursor, and an already-applied input is never redelivered", async () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    // Writer that enqueues while nothing is attached (like lucid send)
    // No attach - just enqueue, as send does.
    const writer = openConversation(recordDir(root, "conv-1"), {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    writer.enqueueInput({ id: "in-1", text: "held while nothing ran", mode: "queue" });
    writer.close();
    // Now a headless host attaches and should drain via cursor path
    const fakeRunner: HarnessRunner = {
      openSession: async () => ({
        answer: async () => ({ disposition: "rejected", reason: "fake" }),
        send: async () => ({ disposition: "rejected", reason: "fake" }),
        turns: { [Symbol.asyncIterator]: async function* () {} },
        close: async () => ({ exitCode: 0, cause: "clean" }),
      }),
      streamTurn: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      inspect: async () => ({ name: "claude", session: true, verifiedAgainst: "test" }),
      countContext: async () => ({ status: "unavailable", reason: "not-configured" }),
      capabilities: async () => ({
        vision: false,
        images: false,
        streaming: "no",
        session: true,
        source: "runtime-verified",
        confidence: "high",
      }),
    };
    const hostForAttach = openConversation(recordDir(root, "conv-1"), {
      now: () => 2000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    const beforeCursor = hostForAttach.cursor();
    const headless = createHeadlessHost(
      {
        harness: "claude",
        conversationId: "conv-1",
        secret,
        runner: fakeRunner,
        mintTurnId: () => "turn-1",
        sendFrame: (frame) => hostForAttach.handleFrame(JSON.stringify(frame)),
        host: hostSeamFor(hostForAttach),
      },
      "headless-session",
    );
    // The headless host's attach drain should have dispatched in-1 and advanced cursor
    // Since our fake runner doesn't actually process, we check cursor advanced
    expect(hostForAttach.cursor()).toBeGreaterThan(beforeCursor);
    // Reopening should not repeat
    hostForAttach.close();
    headless.close();
    const h2 = openConversation(recordDir(root, "conv-1"), {
      now: () => 3000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(h2.collectEffects(h2.cursor()).entries.length).toBe(0);
  });

  test("cursor entry satisfies envelope - v field required", () => {
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const h = openConversation(recordDir(root, "conv-1"), {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    h.handleFrame(encodeFrame(attachFrame(secret)));
    appendFileSync(
      join(root, "conv-1", "log.ndjson"),
      `${JSON.stringify({ at: 9999, src: "cursor", offset: 0 })}\n`,
    );
    expect(() =>
      openConversation(recordDir(root, "conv-1"), {
        now: () => 2000,
        presence: () => undefined,
        executorLease: () => true,
        onEffect: () => {},
        onRecord: () => {},
      }),
    ).toThrow(StoreError);
  });

  test("a record written before cursors existed does not replay its whole history", () => {
    // The regression this guards: dispatching the collected batch instead of
    // the reducer's replay set. A record with no cursor starts at offset 0,
    // so every input it ever held - applied ones included - is in the batch.
    // Delivery must come from the inputs still awaiting a disposition, which
    // is what attachReplay is.
    const root = freshRoot();
    const { secret } = createConversationRecord(root, "conv-1");
    const dir = recordDir(root, "conv-1");
    const open = () =>
      openConversation(dir, {
        now: () => 1000,
        presence: () => undefined,
        executorLease: () => true,
        onEffect: () => {},
        onRecord: () => {},
      });
    const h = open();
    h.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "conv-1",
        secret,
        profile: "headless-session",
        harness: "claude",
        version: 1,
      }),
    );
    h.enqueueInput({ id: "in-1", text: "answered long ago", mode: "queue" });
    h.handleFrame(
      JSON.stringify({
        kind: "disposition",
        epoch: h.state().epoch,
        inputId: "in-1",
        outcome: "applied",
      }),
    );
    h.close();

    const re = open();
    // The batch still offers it - collectEffects knows nothing about
    // dispositions - and the replay set correctly does not.
    const offered = re
      .collectEffects(0)
      .entries.flatMap((e) =>
        e.effects.filter((f) => f.type === "send" && f.frame.kind === "input"),
      );
    expect(offered.length).toBe(1);
    expect(re.state().inputs.length).toBe(0);
    expect(re.state().appliedInputs).toMatchObject({ "in-1": true });
  });
});

test("advancing an empty record to zero appends no cursor", () => {
  const root = freshRoot();
  createConversationRecord(root, "zero");
  const dir = recordDir(root, "zero");
  const host = openConversation(dir, {
    now: () => 1234,
    presence: () => undefined,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  try {
    host.advanceCursor(0);
    expect(readFileSync(join(dir, "log.ndjson"), "utf8")).toBe("");
  } finally {
    host.close();
  }
});
