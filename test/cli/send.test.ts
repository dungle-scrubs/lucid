import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/dispatch.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { SendRefused, sendInput } from "../../src/cli/send.js";
import { INPUT_QUEUE_MAX } from "../../src/protocol/index.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { viewConversation } from "../../src/store/store.js";

/** Drive a real record to `count` in-flight inputs through the host's own
 * seams: attach, then enqueue + applied disposition per input. This is the
 * durable state a live host's harness leaves behind while it is behind -
 * delivered inputs, no turn terminal yet - which is what the bound reads. */
const backlogTo = (
  dir: string,
  secret: string,
  count: number,
): ReturnType<typeof createConversationHost> => {
  const host = createConversationHost(dir, {
    now: () => 1_000,
    presence: () => undefined,
    // The fill driver is a transient writer, exactly like `lucid send`:
    // durable writes, no lease, no dispatch.
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  const accept = (r: { verdict: string; issue?: string }, what: string): void => {
    if (r.verdict !== "accepted") throw new Error(`setup ${what} refused: ${r.issue ?? "?"}`);
  };
  accept(
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "conv-1",
        profile: "headless-session",
        harness: "claude",
        secret,
        version: 1,
      }),
    ),
    "attach",
  );
  for (let i = 1; i <= count; i++) {
    accept(host.enqueueInput({ id: `fill-${i}`, text: `task ${i}`, mode: "queue" }), "enqueue");
    accept(
      host.handleFrame(
        JSON.stringify({
          kind: "disposition",
          epoch: 1,
          inputId: `fill-${i}`,
          outcome: "applied",
        }),
      ),
      "disposition",
    );
  }
  return host;
};

describe("RFC-04: `lucid send` at the input bound", () => {
  test("a send at the bound is refused, the condition is named, and the record is unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-send-bound-"));
    const { secret, dir } = conversations(root).ensure("conv-1");
    backlogTo(dir, secret, INPUT_QUEUE_MAX);
    const before = readFileSync(join(dir, "log.ndjson"), "utf8");

    let refused: unknown;
    try {
      sendInput("conv-1", {
        rootDir: root,
        text: "one too many",
        now: () => 2_000,
        makeId: () => "send-over",
      });
    } catch (e) {
      refused = e;
    }

    // The refusal is the command's failure - thrown, so the process exits
    // non-zero - and its message names the condition a script can match.
    expect(refused).toBeInstanceOf(SendRefused);
    expect((refused as SendRefused).issue).toBe("input-queue-full");
    expect((refused as Error).message).toContain("input-queue-full");
    expect((refused as Error).message).toContain(`${INPUT_QUEUE_MAX} of ${INPUT_QUEUE_MAX}`);

    // "The record is unchanged" means byte-for-byte: a refused transition
    // never writes, and nothing else in a refused send touches the log.
    expect(readFileSync(join(dir, "log.ndjson"), "utf8")).toBe(before);
  });

  test("the refusal reaches the process seam as a rejection - the path main.ts maps to exit 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-send-exit-"));
    const { secret, dir } = conversations(root).ensure("conv-1");
    backlogTo(dir, secret, INPUT_QUEUE_MAX);

    // main.ts awaits runCli and catches: message to stderr, exit(1). A
    // rejection here is the non-zero exit; anything else would exit 0 and
    // a calling script would read "sent" as success.
    await expect(
      runCli(["send", "conv-1", "still flooding"], { rootDir: root }),
    ).rejects.toBeInstanceOf(SendRefused);
  });

  test("below the bound, and after a turn finishes, sending is unaffected", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-send-open-"));
    const { secret, dir } = conversations(root).ensure("conv-1");

    // One slot free: the send lands and a fresh fold sees it outstanding.
    const host = backlogTo(dir, secret, INPUT_QUEUE_MAX - 1);
    const { inputId } = sendInput("conv-1", {
      rootDir: root,
      text: "still room",
      now: () => 2_000,
      makeId: () => "send-ok",
    });
    expect(inputId).toBe("send-ok");
    const view = viewConversation(dir);
    expect(view.state.inFlightInputs).toBe(INPUT_QUEUE_MAX - 1);
    expect(
      view.transcript.inputs.some((i) => i.id === "send-ok" && i.status === "outstanding"),
    ).toBe(true);

    // The harness takes it (applied disposition): the backlog is at the
    // bound and the next send refuses - until one turn's terminal event
    // retires an input and opens the slot back up.
    expect(
      host.handleFrame(
        JSON.stringify({
          kind: "disposition",
          epoch: 1,
          inputId: "send-ok",
          outcome: "applied",
        }),
      ).verdict,
    ).toBe("accepted");
    expect(() =>
      sendInput("conv-1", {
        rootDir: root,
        text: "no room",
        now: () => 2_100,
        makeId: () => "send-blocked",
      }),
    ).toThrow(SendRefused);
    const finished = host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t-1",
        event: { kind: "done", exitCode: 0, cause: "end" },
      }),
    );
    expect(finished.verdict).toBe("accepted");
    sendInput("conv-1", {
      rootDir: root,
      text: "room again",
      now: () => 2_200,
      makeId: () => "send-after-done",
    });
  });
});
