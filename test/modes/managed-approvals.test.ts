import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedApprovals } from "../../src/modes/managed-approvals.js";
import type { ApprovalDecision } from "../../src/protocol/native-approvals.js";
import { createConversationHost, openWriter } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";
import { seedApprovalAttempt } from "../helpers/approval-fixture.js";

test("the current channel claims a durable write before answering a browser choice, exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-managed-approval-"));
  const { paths, secret } = createConversationRecord(root, "approval");
  const host = createConversationHost(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => true,
    onEffect: () => {},
    onRecord: () => {},
  });
  const { attempt, request } = seedApprovalAttempt(host, secret);
  let alive = true;
  const writes: ApprovalDecision[] = [];
  const approvals = createManagedApprovals({
    attempt,
    current: () => true,
    host,
    channel: {
      alive: () => alive,
      answer: (decision) => {
        expect(host.state().approvals[request.requestId]).toMatchObject({
          status: "sending",
          decision: { ...decision, status: "sending" },
        });
        writes.push(decision);
      },
      cancel: () => {
        alive = false;
      },
    },
  });
  const decision = {
    id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
    requestId: request.requestId,
    choiceId: "once",
  };
  try {
    approvals.event({ ...request });
    expect(writes).toEqual([]);
    const writer = openWriter(paths.dir);
    try {
      expect(writer.decideApproval(decision).verdict).toBe("accepted");
    } finally {
      writer.close();
    }
    host.collectEffects(host.cursor());
    expect(writes).toEqual([]);
    approvals.recordChanged();
    approvals.recordChanged();
    expect(writes).toEqual([decision]);
    alive = false;
    approvals.closed();
    approvals.recordChanged();
    expect(writes).toEqual([decision]);
    expect(host.state().approvals[request.requestId]).toMatchObject({
      status: "unavailable",
      decision: { status: "sending" },
    });
    expect(JSON.stringify(host.transcript())).not.toContain("<script>fixture");
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exceeding the pending request bound cancels the whole channel and settles every request after cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-managed-approval-"));
  const { paths, secret } = createConversationRecord(root, "approval");
  const host = createConversationHost(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => true,
    onEffect: () => {},
    onRecord: () => {},
  });
  const { attempt, request } = seedApprovalAttempt(host, secret);
  let cancelled = false;
  const writes: ApprovalDecision[] = [];
  const approvals = createManagedApprovals({
    attempt,
    current: () => true,
    host,
    channel: {
      alive: () => !cancelled,
      answer: (decision) => {
        writes.push(decision);
      },
      cancel: () => {
        cancelled = true;
      },
    },
  });
  try {
    for (let index = 0; index < 32; index++)
      approvals.event({ ...request, requestId: randomUUID() });
    expect(() => approvals.event({ ...request, requestId: randomUUID() })).toThrow();
    expect(cancelled).toBe(true);
    const before = Object.values(host.state().approvals);
    expect(before).toHaveLength(32);
    expect(before.every((entry) => entry.status === "pending")).toBe(true);
    // The process owner invokes closed only after its native process has drained.
    expect(() => approvals.closed()).toThrow();
    const after = Object.values(host.state().approvals);
    expect(after).toHaveLength(32);
    expect(after.every((entry) => entry.status === "unavailable")).toBe(true);
    approvals.recordChanged();
    expect(writes).toEqual([]);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
