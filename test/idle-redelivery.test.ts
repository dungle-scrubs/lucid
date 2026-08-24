/**
 * An input sent to an idle driver is delivered, however long it has been idle.
 *
 * `enqueueInput` delivers into a live lease only; otherwise it queues the
 * input and arms it (`redeliver: !live`). The arming drains at a turn
 * boundary or at the next attach. A driver sitting idle reaches neither —
 * it has no turn to end and does not re-attach while it lives.
 *
 * The lease lapses after LEASE_TTL_MS with nothing written, and waiting for
 * a person to type is exactly that. So the ordinary case (open a
 * conversation, think, send) armed the input and had nowhere to drain it.
 * The record kept it `outstanding` and the send was never answered.
 *
 * The clock is injected, so "the lease has lapsed" is set here rather than
 * waited for.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations } from "../src/cli/record-addressing.js";
import { startHeadless } from "../src/cli/runtime.js";
import type { HarnessRunner } from "../src/harness/runner.js";
import { type Frame, LEASE_TTL_MS } from "../src/protocol/index.js";
import type { acquirePresence, PresenceHandle } from "../src/store/presence.js";
import { openConversation } from "../src/store/store.js";

const fakeRunner = {
  inspect: async () => ({ name: "claude", session: true, verifiedAgainst: "fake" }),
  capabilities: async () => ({
    vision: false,
    images: false,
    streaming: "line",
    session: true,
    source: "curated",
    confidence: "high",
  }),
} as unknown as HarnessRunner;

const fakePresence = (): { acquire: typeof acquirePresence } => {
  let held = false;
  const handle: PresenceHandle = {
    release: (): void => {
      held = false;
    },
    held: () => held,
  };
  return {
    acquire: (() => {
      held = true;
      return handle;
    }) as typeof acquirePresence,
  };
};

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("an idle driver still receives what is sent to it", () => {
  test("an input written after the lease lapsed is delivered, not left outstanding", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-idle-"));
    const convId = "idle-1";
    const { secret } = conversations(root).ensure(convId);
    const dir = join(root, convId);

    let now = 1_000_000;
    const nowFn = (): number => now;

    const delivered: string[] = [];
    let sendFrame!: (frame: Frame) => unknown;

    // A source that attaches for real (so the record holds an attachment
    // with a lease) and records the input frames handed to it.
    const createFakeHost = (deps: { sendFrame: (f: Frame) => unknown }) => {
      sendFrame = deps.sendFrame;
      sendFrame({
        kind: "attach",
        conversationId: convId,
        profile: "headless-session",
        secret,
        version: 1,
        harness: "claude",
      } as unknown as Frame);
      return {
        receive: (frame: Frame): void => {
          if (frame.kind !== "input") return;
          delivered.push(frame.text);
          // Answer it, the way a harness would, so the input stops being
          // outstanding and the ledger settles.
          sendFrame({ kind: "disposition", epoch: 1, inputId: frame.id, outcome: "applied" });
        },
        close: (): void => {},
      };
    };

    const running = await startHeadless({
      rootDir: root,
      conversationId: convId,
      harnessName: "claude",
      runner: fakeRunner,
      acquirePresenceFn: fakePresence().acquire,
      createHeadlessHostFn:
        createFakeHost as unknown as typeof import("../src/modes/host.js").createHeadlessHost,
      presence: () => undefined,
      now: nowFn,
      randomUUID: () => "sess-1",
      pollMs: 10,
    });
    expect(running.kind).toBe("running");
    if (running.kind !== "running") return;

    // A separate process appends, exactly as `lucid2 send` and the browser
    // server both do: no presence lock, no lease, acts on no effect.
    const writer = openConversation(dir, {
      now: nowFn,
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });

    // Inside the lease window — this always worked.
    now += 1_000;
    writer.enqueueInput({ id: "in-fresh", text: "while the lease is live", mode: "queue" });
    await until(() => delivered.includes("while the lease is live"));
    expect(delivered).toContain("while the lease is live");

    // Now let the lease lapse. Nothing is written in the gap, which is what
    // an idle driver waiting for a person looks like.
    now += LEASE_TTL_MS + 1_000;
    writer.enqueueInput({ id: "in-lapsed", text: "after the lease lapsed", mode: "queue" });

    await until(() => delivered.includes("after the lease lapsed"));
    expect(delivered).toContain("after the lease lapsed");

    running.abort();
    await running.done.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
});
