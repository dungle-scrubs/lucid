import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQueuedInputs } from "../../src/modes/interactive-host.js";
import { INPUT_QUEUE_MAX } from "../../src/protocol/events.js";
import { decodeFrame } from "../../src/protocol/frames.js";
import { createConversationRecord, openWriter } from "../../src/store/store.js";

test("managed attachment intent validates and survives source events", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-managed-source-"));
  const { paths, secret } = createConversationRecord(root, "capable");
  const host = openWriter(paths.dir);
  const frame = {
    kind: "attach",
    conversationId: "capable",
    secret,
    version: 1,
    profile: "headless-turn",
    harness: "claude",
    capabilities: ["managed-input-v1"],
    attachmentOrigin: "explicit",
    explicitAttachmentId: "user-attach",
  };
  try {
    expect(
      decodeFrame({ ...frame, capabilities: ["managed-input-v1", "managed-input-v1"] }).verdict,
    ).toBe("refused");
    expect(decodeFrame({ ...frame, explicitAttachmentId: undefined }).verdict).toBe("refused");
    expect(host.handleFrame(JSON.stringify(frame)).verdict).toBe("accepted");
    host.handleFrame(
      JSON.stringify({
        kind: "event",
        epoch: 1,
        n: 1,
        turnId: "t",
        event: { kind: "message", text: "hello" },
      }),
    );
    expect(host.state().attachment).toMatchObject({
      capabilities: ["managed-input-v1"],
      attachmentOrigin: "explicit",
      explicitAttachmentId: "user-attach",
    });
    expect(host.state().explicitAttachments).toEqual({ "user-attach": 1 });
  } finally {
    host.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("a repeated accepted input recovers its receipt after reopen without a second input", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-acceptance-"));
  const { paths } = createConversationRecord(root, "receipt");
  const input = { id: "browser-request", mode: "queue" as const, text: "continue" };
  const first = openWriter(paths.dir);
  const accepted = first.acceptInput(input);
  first.close();
  const reopened = openWriter(paths.dir);
  try {
    expect(accepted).toMatchObject({ verdict: "accepted", receipt: { inputId: input.id, seq: 1 } });
    expect(reopened.acceptInput(input)).toEqual(accepted);
    expect(reopened.transcript().inputs).toHaveLength(1);
    expect(reopened.state().seq).toBe(1);
    expect(reopened.enqueueInput(input)).toMatchObject({
      verdict: "refused",
      issue: "input-id-reused",
    });
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed acceptance records prompt and authorization together and fences an old source", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-managed-acceptance-"));
  const { paths, secret } = createConversationRecord(root, "managed");
  const input = { id: "managed-input", text: "do the work", mode: "queue" as const };
  const first = openWriter(paths.dir);
  const receipt = first.acceptInput(input, { managed: true });
  first.close();
  const reopened = openWriter(paths.dir);
  try {
    expect(readFileSync(join(paths.dir, "log.ndjson"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(reopened.state().executions[input.id]).toMatchObject({ kind: "requested", attempt: 0 });
    expect(readQueuedInputs(paths.dir)).toEqual([]);
    expect(reopened.acceptInput(input, { managed: true })).toEqual(receipt);
    const attached = reopened.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "managed",
        secret,
        version: 1,
        profile: "headless-turn",
        harness: "claude",
      }),
    );
    if (attached.verdict !== "accepted") throw new Error("expected source attachment");
    expect(
      attached.effects.some((effect) => effect.type === "send" && effect.frame.kind === "input"),
    ).toBe(false);
    expect(reopened.transcript().inputs).toHaveLength(1);
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an applied receipt precedes queue capacity and conflicting payload checks", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-accepted-applied-"));
  const { paths, secret } = createConversationRecord(root, "applied");
  const host = openWriter(paths.dir);
  const input = { id: "accepted", mode: "queue" as const, text: "original" };
  const receipt = host.acceptInput(input);
  try {
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "applied",
        secret,
        version: 1,
        profile: "headless-turn",
        harness: "claude",
      }),
    );
    host.handleFrame(
      JSON.stringify({ kind: "disposition", epoch: 1, inputId: input.id, outcome: "applied" }),
    );
    for (let index = 1; index < INPUT_QUEUE_MAX; index++) {
      const id = `queued-${index}`;
      expect(host.enqueueInput({ id, text: id, mode: "queue" }).verdict).toBe("accepted");
      host.handleFrame(
        JSON.stringify({ kind: "disposition", epoch: 1, inputId: id, outcome: "applied" }),
      );
    }
    expect(host.enqueueInput({ id: "full", text: "full", mode: "queue" })).toMatchObject({
      verdict: "refused",
      issue: "input-queue-full",
    });
    expect(host.acceptInput(input)).toEqual(receipt);
    expect(host.acceptInput({ ...input, text: "different" })).toEqual({
      verdict: "refused",
      issue: "E-COMP-06",
    });
    expect(host.transcript().inputs.filter((entry) => entry.id === input.id)).toHaveLength(1);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
