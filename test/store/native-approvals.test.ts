import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalAttempt, ApprovalRequest } from "../../src/protocol/native-approvals.js";
import type { ConversationHost } from "../../src/store/conversation-host.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";
import { seedApprovalAttempt } from "../helpers/approval-fixture.js";

// Synthetic managed attempt and HCN request, not a recorded native fixture.
function fixture(): {
  readonly attempt: ApprovalAttempt;
  readonly close: () => void;
  readonly host: ConversationHost;
  readonly lease: (value: boolean) => void;
  readonly reopen: () => void;
  readonly replaceExecutor: () => ReturnType<ConversationHost["handleFrame"]>;
  readonly request: ApprovalRequest;
} {
  const root = mkdtempSync(join(tmpdir(), "lucid-native-approval-"));
  const { paths, secret } = createConversationRecord(root, "approval");
  let lease = true;
  let now = 1;
  const open = () =>
    createConversationHost(paths.dir, {
      now: () => now,
      presence: () => false,
      executorLease: () => lease,
      onEffect: () => {},
      onRecord: () => {},
    });
  let host = open();
  const { attempt, request } = seedApprovalAttempt(host, secret);
  return {
    attempt,
    request,
    get host() {
      return host;
    },
    lease: (value: boolean) => {
      lease = value;
    },
    reopen: () => {
      host.close();
      host = open();
    },
    replaceExecutor: () => {
      now += 60_000;
      return host.handleFrame(
        JSON.stringify({
          kind: "attach",
          conversationId: "approval",
          secret,
          version: 1,
          harness: "codex",
          profile: "headless-turn",
          capabilities: ["managed-input-v1"],
          attachmentOrigin: "automatic",
        }),
      );
    },
    close: () => {
      host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("only a current managed executor can durably publish a native approval request", () => {
  const f = fixture();
  try {
    const fact = { ...f.attempt, kind: "request", request: f.request };
    f.lease(false);
    expect(f.host.writeApproval(fact).verdict).toBe("refused");
    f.lease(true);
    expect(f.host.writeApproval({ ...fact, epoch: 0 }).verdict).toBe("refused");
    expect(
      f.host.writeApproval({ ...fact, request: { ...f.request, sessionId: "foreign" } }).verdict,
    ).toBe("refused");
    expect(f.host.writeApproval(fact).verdict).toBe("accepted");
    f.reopen();
    expect(f.host.state().approvals[f.request.requestId]).toMatchObject({
      ...f.attempt,
      request: f.request,
      status: "pending",
    });
    const seq = f.host.state().seq;
    expect(f.host.writeApproval(fact).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(seq);
    expect(JSON.stringify(f.host.state().contextContent)).not.toContain("<script>fixture");
    expect(f.host.transcript().inputs).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("a browser choice survives reopen and its write intent can be claimed only once", () => {
  const f = fixture();
  try {
    f.host.writeApproval({ ...f.attempt, kind: "request", request: f.request });
    f.lease(false);
    const decision = {
      id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
      requestId: f.request.requestId,
      choiceId: "once",
    };
    expect(f.host.decideApproval({ ...decision, choiceId: "unoffered" }).verdict).toBe("refused");
    expect(f.host.decideApproval(decision).verdict).toBe("accepted");
    f.reopen();
    expect(f.host.state().approvals[f.request.requestId]).toMatchObject({
      status: "decided",
      decision: { ...decision, status: "decided" },
    });
    const seq = f.host.state().seq;
    expect(f.host.decideApproval(decision).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(seq);
    expect(
      f.host.decideApproval({ ...decision, id: "407feafe-e82b-4df4-91ba-4f1aeb987508" }).verdict,
    ).toBe("refused");
    const intent = {
      ...f.attempt,
      kind: "write-intent",
      id: decision.id,
      requestId: decision.requestId,
    };
    expect(f.host.writeApproval(intent).verdict).toBe("refused");
    f.lease(true);
    expect(f.host.writeApproval(intent).verdict).toBe("accepted");
    f.reopen();
    expect(f.host.state().approvals[f.request.requestId]).toMatchObject({
      status: "sending",
      decision: { ...decision, status: "sending" },
    });
    expect(f.host.writeApproval(intent).verdict).toBe("refused");
    expect(f.host.decideApproval(decision).verdict).toBe("accepted");
    expect(f.host.state().approvals[f.request.requestId]?.status).toBe("sending");
  } finally {
    f.close();
  }
});

test("a native clear retains the chosen answer and a late sent acknowledgement cannot reopen it", () => {
  const f = fixture();
  try {
    f.host.writeApproval({ ...f.attempt, kind: "request", request: f.request });
    const decision = {
      id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
      requestId: f.request.requestId,
      choiceId: "once",
    };
    f.host.decideApproval(decision);
    const intent = {
      ...f.attempt,
      kind: "write-intent",
      id: decision.id,
      requestId: decision.requestId,
    };
    f.host.writeApproval(intent);
    expect(
      f.host.writeApproval({
        ...f.attempt,
        kind: "cleared",
        requestId: decision.requestId,
        reason: "native-resolved",
      }).verdict,
    ).toBe("accepted");
    expect(
      f.host.writeApproval({
        ...f.attempt,
        kind: "disposition",
        id: decision.id,
        requestId: decision.requestId,
        status: "sent",
      }).verdict,
    ).toBe("accepted");
    f.reopen();
    expect(f.host.state().approvals[decision.requestId]).toMatchObject({
      status: "cleared",
      reason: "native-resolved",
      decision: { ...decision, status: "sent" },
    });
    expect(
      f.host.decideApproval({ ...decision, id: "407feafe-e82b-4df4-91ba-4f1aeb987508" }).verdict,
    ).toBe("refused");
    expect(f.host.writeApproval(intent).verdict).toBe("refused");
  } finally {
    f.close();
  }
});

test.each(["pending", "decided", "sending", "sent"] as const)(
  "settling a lost attempt makes its %s request unavailable without changing delivery evidence",
  (stage) => {
    const f = fixture();
    try {
      f.host.writeApproval({ ...f.attempt, kind: "request", request: f.request });
      const decision = {
        id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
        requestId: f.request.requestId,
        choiceId: "once",
      };
      if (stage !== "pending") f.host.decideApproval(decision);
      if (stage === "sending" || stage === "sent")
        f.host.writeApproval({
          ...f.attempt,
          kind: "write-intent",
          id: decision.id,
          requestId: decision.requestId,
        });
      if (stage === "sent")
        f.host.writeApproval({
          ...f.attempt,
          kind: "disposition",
          id: decision.id,
          requestId: decision.requestId,
          status: "sent",
        });
      expect(
        f.host.writeExecution({
          ...f.attempt,
          kind: "attempt-ended",
          outcome: {
            kind: "uncertain",
            failure: {
              code: "E-HUB-07",
              evidence: "process-lost",
              reason: "Fixture worker disappeared",
            },
          },
        }).verdict,
      ).toBe("accepted");
      f.reopen();
      const approval = f.host.state().approvals[decision.requestId];
      expect(approval).toMatchObject({ status: "unavailable", reason: "process-ended" });
      if (stage === "pending") expect(approval?.decision).toBeUndefined();
      else expect(approval?.decision).toMatchObject({ ...decision, status: stage });
      expect(
        f.host.writeApproval({
          ...f.attempt,
          kind: "write-intent",
          id: decision.id,
          requestId: decision.requestId,
        }).verdict,
      ).toBe("refused");
      expect(
        f.host.decideApproval({ ...decision, id: "407feafe-e82b-4df4-91ba-4f1aeb987508" }).verdict,
      ).toBe("refused");
    } finally {
      f.close();
    }
  },
);

test("a replacement executor makes the old process request unavailable before recovery or dispatch", () => {
  const f = fixture();
  try {
    f.host.writeApproval({ ...f.attempt, kind: "request", request: f.request });
    const decision = {
      id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
      requestId: f.request.requestId,
      choiceId: "once",
    };
    f.host.decideApproval(decision);
    const intent = {
      ...f.attempt,
      kind: "write-intent",
      id: decision.id,
      requestId: decision.requestId,
    };
    f.host.writeApproval(intent);
    expect(f.replaceExecutor().verdict).toBe("accepted");
    f.reopen();
    expect(f.host.state().epoch).toBe(2);
    expect(f.host.state().approvals[decision.requestId]).toMatchObject({
      status: "unavailable",
      reason: "executor-replaced",
      decision: { ...decision, status: "sending" },
    });
    expect(f.host.writeApproval(intent).verdict).toBe("refused");
    expect(
      f.host.decideApproval({ ...decision, id: "407feafe-e82b-4df4-91ba-4f1aeb987508" }).verdict,
    ).toBe("refused");
  } finally {
    f.close();
  }
});

test("source text and browser-supplied native payloads cannot create approval authority", () => {
  const f = fixture();
  try {
    const fakeId = "507feafe-e82b-4df4-91ba-4f1aeb987508";
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 1,
          turnId: f.attempt.turnId,
          event: { ...f.request, requestId: fakeId },
        }),
      ).verdict,
    ).toBe("accepted");
    expect(f.host.state().approvals[fakeId]).toBeUndefined();
    const decision = {
      id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
      requestId: f.request.requestId,
      choiceId: "once",
    };
    expect(f.host.decideApproval({ ...decision, requestId: fakeId }).verdict).toBe("refused");
    expect(
      f.host.writeApproval({ ...f.attempt, kind: "request", request: f.request }).verdict,
    ).toBe("accepted");
    expect(
      f.host.decideApproval({ ...decision, payload: { decision: "acceptForSession" } }).verdict,
    ).toBe("refused");
    expect(f.host.writeApproval({ ...f.attempt, kind: "decision", decision }).verdict).toBe(
      "refused",
    );
    expect(f.host.decideApproval({ ...decision, id: "model-authored" }).verdict).toBe("refused");
    expect(
      f.host.writeApproval({
        ...f.attempt,
        kind: "request",
        request: { ...f.request, requestId: "__proto__" },
      }).verdict,
    ).toBe("refused");
    expect(f.host.state().approvals[f.request.requestId]?.status).toBe("pending");
  } finally {
    f.close();
  }
});

test("an explicit HCN rejection records that the chosen answer was not sent and never authorizes another write", () => {
  const f = fixture();
  try {
    f.host.writeApproval({ ...f.attempt, kind: "request", request: f.request });
    const decision = {
      id: "307feafe-e82b-4df4-91ba-4f1aeb987508",
      requestId: f.request.requestId,
      choiceId: "once",
    };
    f.host.decideApproval(decision);
    const intent = {
      ...f.attempt,
      kind: "write-intent",
      id: decision.id,
      requestId: decision.requestId,
    };
    f.host.writeApproval(intent);
    const rejected = {
      ...f.attempt,
      kind: "disposition",
      id: decision.id,
      requestId: decision.requestId,
      status: "rejected",
      reason: "request-unavailable",
    };
    expect(f.host.writeApproval(rejected).verdict).toBe("accepted");
    f.reopen();
    expect(f.host.state().approvals[decision.requestId]).toMatchObject({
      status: "unavailable",
      decision: { ...decision, status: "rejected", reason: "request-unavailable" },
    });
    expect(f.host.writeApproval(rejected).verdict).toBe("accepted");
    expect(f.host.writeApproval(intent).verdict).toBe("refused");
    expect(
      f.host.decideApproval({ ...decision, id: "407feafe-e82b-4df4-91ba-4f1aeb987508" }).verdict,
    ).toBe("refused");
  } finally {
    f.close();
  }
});

test("a managed attempt admits at most 32 unresolved native requests and releases capacity only after a clear", () => {
  const f = fixture();
  try {
    const requestId = (index: number) =>
      `${String(index).padStart(8, "0")}-e82b-4df4-91ba-4f1aeb987508`;
    const add = (index: number) =>
      f.host.writeApproval({
        ...f.attempt,
        kind: "request",
        request: { ...f.request, requestId: requestId(index), details: `Fixture command ${index}` },
      });
    for (let index = 0; index < 32; index++) expect(add(index).verdict).toBe("accepted");
    const seq = f.host.state().seq;
    expect(add(32).verdict).toBe("refused");
    expect(f.host.state().seq).toBe(seq);
    expect(Object.keys(f.host.state().approvals)).toHaveLength(32);
    f.host.writeApproval({
      ...f.attempt,
      kind: "cleared",
      requestId: requestId(0),
      reason: "native-resolved",
    });
    expect(add(32).verdict).toBe("accepted");
  } finally {
    f.close();
  }
});

test("an unsupported approval request field cannot be silently discarded into an actionable request", () => {
  const f = fixture();
  try {
    const seq = f.host.state().seq;
    expect(
      f.host.writeApproval({
        ...f.attempt,
        kind: "request",
        request: { ...f.request, groupScope: "unrepresented future scope" },
      }).verdict,
    ).toBe("refused");
    expect(f.host.state().seq).toBe(seq);
    expect(f.host.state().approvals[f.request.requestId]).toBeUndefined();
  } finally {
    f.close();
  }
});
