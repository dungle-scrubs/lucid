import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRunner } from "../../src/harness/runner.js";
import { TOKEN_HEADER } from "../../src/server/constants.js";
import { startServer } from "../../src/server/server.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { acquirePresence } from "../../src/store/presence.js";
import { createConversationRecord } from "../../src/store/store.js";
import { seedApprovalAttempt } from "../helpers/approval-fixture.js";

test("authenticated browser decisions are durable and duplicate-safe while reads never claim a native write", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-approval-api-"));
  const { paths, secret } = createConversationRecord(root, "approval", { workingDirectory: root });
  const lease = acquirePresence(paths.dir, "approval");
  const host = createConversationHost(paths.dir, {
    now: Date.now,
    presence: () => false,
    executorLease: lease.held,
    onEffect: () => {},
    onRecord: () => {},
  });
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected harness operation");
  };
  const runner: HarnessRunner = {
    capabilities: unused,
    countContext: unused,
    openSession: unused,
    inspect: async () => ({ name: "codex", session: false }),
    streamTurn: () => {
      throw new Error("Unexpected task dispatch");
    },
  };
  const { attempt, request } = seedApprovalAttempt(host, secret);
  const requestId = request.requestId;
  host.writeApproval({ ...attempt, kind: "request", request });
  const server = await startServer({
    rootDir: root,
    port: 0,
    token: "fixture-browser-token",
    runner,
  });
  const endpoint = `${server.url}/api/conversations/approval/approvals/decision`;
  const decision = { id: "307feafe-e82b-4df4-91ba-4f1aeb987508", requestId, choiceId: "once" };
  const send = (authenticated: boolean, extraHeaders: Record<string, string> = {}) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { [TOKEN_HEADER]: server.token } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(decision),
    });
  try {
    expect((await send(false)).status).toBe(401);
    expect((await send(true, { Origin: "null" })).status).toBe(403);
    const replies = await Promise.all([send(true), send(true)]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    for (const reply of replies)
      expect(await reply.json()).toMatchObject({
        approval: { status: "decided", request: { requestId } },
      });
    let approvalRevision = "";
    for (let index = 0; index < 2; index++) {
      const read = await fetch(`${server.url}/api/conversations/approval`, {
        headers: { [TOKEN_HEADER]: server.token },
      });
      const body = await read.json();
      expect(body).toMatchObject({
        approvals: [{ status: "decided", request: { requestId } }],
      });
      approvalRevision = body.approvalRevision;
    }
    expect(typeof approvalRevision).toBe("string");
    host.grantCredit(1);
    const unchanged = await fetch(
      `${server.url}/api/conversations/approval?approvalRevision=${encodeURIComponent(approvalRevision)}`,
      {
        headers: { [TOKEN_HEADER]: server.token },
      },
    );
    const unchangedBody = await unchanged.json();
    expect(unchangedBody.approvalRevision).toBe(approvalRevision);
    expect(unchangedBody).not.toHaveProperty("approvals");
    lease.release();
    expect((await send(true)).status).toBe(200);
    const unavailable = await fetch(
      `${server.url}/api/conversations/approval?approvalRevision=${encodeURIComponent(approvalRevision)}`,
      {
        headers: { [TOKEN_HEADER]: server.token },
      },
    );
    expect(await unavailable.json()).toMatchObject({
      approvals: [{ status: "unavailable", decision: { status: "decided" } }],
    });
    host.close();
    const reopened = createConversationHost(paths.dir, {
      now: Date.now,
      presence: () => false,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    try {
      expect(reopened.state().approvals[requestId]).toMatchObject({
        status: "decided",
        decision: { ...decision, status: "decided" },
      });
    } finally {
      reopened.close();
    }
  } finally {
    await server.close();
    host.close();
    lease.release();
    rmSync(root, { recursive: true, force: true });
  }
});
