import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

test("native identity retains only an owner corroborated at attachment, including after reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-native-owner-"));
  const { paths, secret } = createConversationRecord(root, "owned");
  const owner = { pid: 71, startedAt: "Mon Sep 7 12:00:00 2026", executable: "/bin/claude" };
  const host = openConversation(paths.dir, {
    now: () => 1000,
    presence: () => undefined,
    executorLease: () => false,
    ownerPresence: (claim) => claim.pid === 71,
    onRecord: () => {},
    onEffect: () => {},
  });
  const attached = host.handleFrame(
    JSON.stringify({
      kind: "attach",
      conversationId: "owned",
      secret,
      version: 1,
      profile: "interactive",
      harness: "claude",
      owner,
    }),
  );
  expect(attached.verdict).toBe("accepted");
  host.handleFrame(
    JSON.stringify({
      kind: "event",
      epoch: 1,
      n: 1,
      turnId: "owner-turn",
      event: { kind: "identity", sessionId: "native-owned", authority: "harness-minted" },
    }),
  );
  host.close();
  const reopened = openConversation(paths.dir, {
    now: () => 2000,
    presence: () => undefined,
    executorLease: () => false,
    onRecord: () => {},
    onEffect: () => {},
  });
  try {
    expect(reopened.state().nativeSessions.claude).toMatchObject({
      sessionId: "native-owned",
      epoch: 1,
      owner,
    });
  } finally {
    reopened.close();
  }
});

test("an older living terminal owner blocks headless attach after the latest owner departs", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-overlap-owner-"));
  const { paths, secret } = createConversationRecord(root, "overlap");
  const alive = new Set([71, 72]);
  const host = openConversation(paths.dir, {
    now: () => 1000,
    presence: () => false,
    executorLease: () => false,
    ownerPresence: (claim) => alive.has(claim.pid),
    onRecord: () => {},
    onEffect: () => {},
  });
  const attach = (profile: string, pid?: number) =>
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "overlap",
        secret,
        version: 1,
        profile,
        harness: "claude",
        ...(pid === undefined
          ? {}
          : { owner: { pid, startedAt: "start", executable: "/bin/claude" } }),
      }),
    );
  try {
    for (const pid of [71, 72]) {
      expect(attach("interactive", pid).verdict).toBe("accepted");
      host.handleFrame(
        JSON.stringify({ kind: "detach", epoch: host.state().epoch, reason: "yield" }),
      );
    }
    alive.delete(72);
    expect(() => attach("headless-turn")).toThrow("terminal owner");
    expect(host.state().epoch).toBe(2);
    alive.delete(71);
    expect(attach("headless-turn").verdict).toBe("accepted");
    expect(host.state().terminalParticipations).toEqual([]);
  } finally {
    host.close();
  }
});
