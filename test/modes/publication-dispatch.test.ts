import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { hostSeamFor, openHeadlessSession, openHeadlessTurns } from "../../src/modes/host.js";
import { createConversationHost, openWriter } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";
import { FakeHcnProcess } from "../harness/fakes.js";

test("publication winning the final process-start race creates no ordinary HCN child", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-dispatch-"));
  const { paths, secret } = createConversationRecord(root, "race");
  const host = createConversationHost(paths.dir, {
    executorLease: () => true,
    now: () => 1000,
    onEffect: () => {},
    onRecord: () => {},
    presence: () => false,
  });
  const publisher = openWriter(paths.dir);
  let spawns = 0;
  const evidence: string[] = [];
  let checks = 0;
  let cursorAtRequirement = 0;
  try {
    host.enqueueInput({ id: "pending", mode: "queue", text: "Do not start this" });
    const source = openHeadlessTurns({
      beforeProcess: async () => {
        checks++;
        cursorAtRequirement = host.cursor();
        expect(publisher.recordNativePublication().verdict).toBe("accepted");
      },
      conversationId: "race",
      harness: "codex",
      host: hostSeamFor(host),
      mintTurnId: () => "not-started",
      onDispatchRejected: (_turnId, reason) => {
        evidence.push(reason);
      },
      runner: createHcnRunner({
        bin: "/fake/hcn",
        spawn: () => {
          spawns++;
          throw new Error("Unexpected process creation");
        },
      }),
      secret,
      sendFrame: (frame) => host.handleFrame(JSON.stringify(frame)),
    });
    try {
      await source.settled;
      expect(checks).toBe(1);
      expect(spawns).toBe(0);
      expect(evidence).toEqual(["dispatch-not-called"]);
      expect(host.state().appliedInputs.pending).toBeUndefined();
      expect(host.cursor()).toBe(cursorAtRequirement);
    } finally {
      source.close();
    }
  } finally {
    publisher.close();
    host.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("session startup settles cleanly when publication records its requirement after attachment", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-session-start-"));
  const { paths, secret } = createConversationRecord(root, "session-race");
  const host = createConversationHost(paths.dir, {
    executorLease: () => true,
    now: () => 1000,
    onEffect: () => {},
    onRecord: () => {},
    presence: () => false,
  });
  const publisher = openWriter(paths.dir);
  let spawns = 0;
  const evidence: string[] = [];
  try {
    const source = openHeadlessSession({
      conversationId: "session-race",
      harness: "codex",
      host: hostSeamFor(host),
      mintTurnId: () => "not-started",
      sessionId: "session",
      onAttached: () => {
        expect(publisher.recordNativePublication().verdict).toBe("accepted");
        return [];
      },
      onDispatchRejected: (_turnId, reason) => {
        evidence.push(reason);
      },
      runner: createHcnRunner({
        bin: "/fake/hcn",
        spawn: () => {
          spawns++;
          throw new Error("Unexpected process creation");
        },
      }),
      secret,
      sendFrame: (frame) => host.handleFrame(JSON.stringify(frame)),
    });
    try {
      await source.settled;
      expect(spawns).toBe(0);
      expect(evidence).toEqual(["dispatch-not-called"]);
      expect(host.state().attachment).toBeNull();
    } finally {
      source.close();
    }
  } finally {
    publisher.close();
    host.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("a held session send reports connection admission without claiming the process closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-session-send-"));
  const { paths, secret } = createConversationRecord(root, "send-race");
  const host = createConversationHost(paths.dir, {
    executorLease: () => true,
    now: () => 1000,
    onEffect: () => {},
    onRecord: () => {},
    presence: () => false,
  });
  const proc = new FakeHcnProcess();
  const rejected = Promise.withResolvers<string | undefined>();
  const evidence: string[] = [];
  const source = openHeadlessSession({
    conversationId: "send-race",
    harness: "codex",
    host: hostSeamFor(host),
    mintTurnId: () => "not-started",
    sessionId: "session",
    onDispatchRejected: (_turnId, reason) => {
      evidence.push(reason);
    },
    runner: createHcnRunner({ bin: "/fake/hcn", spawn: () => proc }),
    secret,
    sendFrame: (frame) => {
      const result = host.handleFrame(JSON.stringify(frame));
      if (frame.kind === "disposition" && frame.outcome === "rejected")
        rejected.resolve(frame.note);
      return result;
    },
  });
  try {
    const accepted = host.enqueueInput({ id: "pending", mode: "queue", text: "Still queued" });
    for (const effect of accepted.effects) if (effect.type === "send") source.receive(effect.frame);
    expect(host.recordNativePublication().verdict).toBe("accepted");
    // Synthetic normalized session readiness, not a captured native recording.
    proc.emit({
      kind: "session",
      sessionId: "session",
      harness: "codex",
      hcn: "synthetic",
      escalateQuestions: true,
    });
    expect(await rejected.promise).toContain("connection-not-admitted");
    expect(evidence).toEqual(["dispatch-not-called"]);
    expect(
      proc.commands.filter((command) => command.op === "send" || command.op === "answer"),
    ).toEqual([]);
    expect(proc.signals).toEqual([]);
    expect(host.state().appliedInputs.pending).toBeUndefined();
  } finally {
    source.close();
    proc.exit(0);
    await source.settled;
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
