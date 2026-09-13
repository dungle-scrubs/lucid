import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConnection } from "../../src/store/connection-view.js";
import { createConversationHost, openWriter } from "../../src/store/conversation-host.js";
import { createConversationRecord, viewConversation } from "../../src/store/store.js";
import { attach } from "../protocol/helpers.js";

test("a verified binding survives replay and refuses a different native session", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-connection-"));
  const binding = {
    generation: crypto.randomUUID(),
    harness: "codex" as const,
    interface: "codex-cli" as const,
    nativeSessionId: "native-one",
    owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
    registrationId: crypto.randomUUID(),
    workingDirectory: root,
  };
  try {
    const { paths } = createConversationRecord(root, "artifact", { workingDirectory: root });
    let current = binding;
    const host = createConversationHost(paths.dir, {
      connectionAuthority: () => current,
      executorLease: () => false,
      now: () => 1000,
      onEffect: () => {},
      onRecord: () => {},
      ownerPresence: () => true,
      presence: () => undefined,
    });
    const fact = { actionId: crypto.randomUUID(), binding, kind: "bound" as const };
    try {
      expect(host.writeConnection(fact).verdict).toBe("accepted");
      const seq = host.state().seq;
      expect(host.writeConnection(fact).verdict).toBe("accepted");
      expect(host.state().seq).toBe(seq);
      current = { ...binding, generation: crypto.randomUUID(), nativeSessionId: "native-two" };
      expect(
        host.writeConnection({ ...fact, actionId: crypto.randomUUID(), binding: current }),
      ).toMatchObject({
        issue: "connection-conflict",
        verdict: "refused",
      });
    } finally {
      host.close();
    }
    const reopened = openWriter(paths.dir);
    try {
      expect(reopened.state().connection?.binding).toEqual(binding);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an unknown connection envelope is refused without discarding its admission facts", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-connection-version-"));
  try {
    const { paths } = createConversationRecord(root, "artifact");
    // Synthetic future control envelope, not a captured harness fixture.
    appendFileSync(
      paths.logPath,
      `${JSON.stringify({ at: 1, connection: { kind: "future-control" }, payloadVersion: 73, src: "execution", v: 1 })}\n`,
    );
    const before = readFileSync(paths.logPath);
    let code: string | undefined;
    try {
      viewConversation(paths.dir);
    } catch (error) {
      if (error instanceof Error && "code" in error) code = String(error.code);
    }
    expect(code).toBe("unsupported-connection-payload");
    expect(readFileSync(paths.logPath)).toEqual(before);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("connection status refreshes native ownership without writing or treating unknown as closed", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-connection-status-"));
  try {
    const { paths } = createConversationRecord(root, "artifact", { workingDirectory: root });
    const binding = {
      generation: crypto.randomUUID(),
      harness: "codex" as const,
      interface: "codex-cli" as const,
      nativeSessionId: "native-one",
      owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
      registrationId: crypto.randomUUID(),
      workingDirectory: root,
    };
    const host = createConversationHost(paths.dir, {
      connectionAuthority: () => binding,
      executorLease: () => false,
      now: () => 1000,
      onEffect: () => {},
      onRecord: () => {},
      ownerPresence: () => true,
      presence: () => undefined,
    });
    expect(
      host.writeConnection({ actionId: crypto.randomUUID(), binding, kind: "bound" }).verdict,
    ).toBe("accepted");
    host.close();
    const before = readFileSync(paths.logPath);
    let presence: boolean | undefined = true;
    const deps = { now: () => 2000, ownerPresence: () => presence };
    expect(readConnection(paths.dir, deps)).toMatchObject({
      actions: ["resume-listening-instructions"],
      message: "Your interactive session is still open. Tell it to resume listening.",
      nativeSessionId: "native-one",
      state: "not-listening",
    });
    presence = undefined;
    expect(readConnection(paths.dir, deps)).toMatchObject({
      actions: ["retry-detection"],
      state: "owner-unknown",
    });
    presence = false;
    expect(readConnection(paths.dir, deps)).toMatchObject({
      actions: ["reconnect-instructions"],
      state: "closed",
    });
    expect(readFileSync(paths.logPath)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy record without a working folder cannot bind an arbitrary native folder", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-connection-folderless-"));
  try {
    const { paths } = createConversationRecord(root, "artifact");
    const binding = {
      generation: crypto.randomUUID(),
      harness: "codex" as const,
      interface: "codex-cli" as const,
      nativeSessionId: "native-one",
      owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
      registrationId: crypto.randomUUID(),
      workingDirectory: root,
    };
    const host = createConversationHost(paths.dir, {
      connectionAuthority: () => binding,
      executorLease: () => false,
      now: () => 1000,
      onEffect: () => {},
      onRecord: () => {},
      ownerPresence: () => true,
      presence: () => undefined,
    });
    try {
      const result = host.writeConnection({
        actionId: crypto.randomUUID(),
        binding,
        kind: "bound",
      });
      expect(result.verdict).toBe("refused");
      if (result.verdict === "refused") expect(result.issue).toBe("connection-folder-unverified");
      expect(host.state().connection).toBeNull();
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a departed bound owner does not authorize a headless attach without continuation admission", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-connection-admission-"));
  try {
    const { paths, secret } = createConversationRecord(root, "artifact", {
      workingDirectory: root,
    });
    const binding = {
      generation: crypto.randomUUID(),
      harness: "codex" as const,
      interface: "codex-cli" as const,
      nativeSessionId: "native-one",
      owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
      registrationId: crypto.randomUUID(),
      workingDirectory: root,
    };
    let alive = true;
    const host = createConversationHost(paths.dir, {
      connectionAuthority: () => binding,
      executorLease: () => true,
      now: () => 1000,
      onEffect: () => {},
      onRecord: () => {},
      ownerPresence: () => alive,
      presence: () => false,
    });
    try {
      expect(
        host.writeConnection({ actionId: crypto.randomUUID(), binding, kind: "bound" }).verdict,
      ).toBe("accepted");
      alive = false;
      const result = host.handleFrame(
        JSON.stringify(
          attach({
            conversationId: "artifact",
            harness: "codex",
            profile: "headless-turn",
            secret,
          }),
        ),
      );
      expect(result.verdict).toBe("refused");
      if (result.verdict === "refused") expect(result.issue).toBe("connection-not-admitted");
      expect(host.state().attachment).toBeNull();
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
