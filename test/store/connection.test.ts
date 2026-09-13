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

test("a publication requirement fences executor acquisition, attachment and an earlier prepared attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-admission-"));
  const { paths, secret } = createConversationRecord(root, "publication");
  const host = createConversationHost(paths.dir, {
    executorLease: () => true,
    now: () => 1000,
    onEffect: () => {},
    onRecord: () => {},
    presence: () => false,
  });
  const publisher = openWriter(paths.dir);
  const frame = {
    attachmentOrigin: "automatic",
    kind: "attach",
    conversationId: "publication",
    secret,
    version: 1,
    harness: "codex",
    profile: "headless-turn",
    capabilities: ["managed-input-v1"],
  };
  let acquisitions = 0;
  let releases = 0;
  const acquire = () => {
    acquisitions++;
    expect(publisher.recordNativePublication().verdict).toBe("accepted");
    return {
      held: () => true,
      release: () => {
        releases++;
      },
    };
  };
  try {
    expect(
      host.acceptInput({ id: "queued", mode: "queue", text: "Keep this" }, { managed: true })
        .verdict,
    ).toBe("accepted");
    expect(host.handleFrame(JSON.stringify(frame)).verdict).toBe("accepted");
    const epoch = host.state().epoch;
    expect(host.acquireExecutor({ kind: "headless" }, acquire)).toMatchObject({
      verdict: "refused",
      issue: "connection-not-admitted",
    });
    expect(acquisitions).toBe(1);
    expect(releases).toBe(1);
    expect(
      host.writeExecution({
        kind: "attempt-started",
        attempt: 1,
        epoch,
        inputId: "queued",
        turnId: "not-started",
        driver: { harness: "codex", model: "test-model", effort: "high", profile: "headless-turn" },
        native: { kind: "fresh" },
        context: { digest: "a".repeat(64), from: 0, through: 1 },
      }),
    ).toMatchObject({ verdict: "refused", issue: "connection-not-admitted" });
    expect(
      host.handleFrame(JSON.stringify({ kind: "detach", epoch, reason: "shutdown" })).verdict,
    ).toBe("accepted");
    expect(host.handleFrame(JSON.stringify(frame))).toMatchObject({
      verdict: "refused",
      issue: "connection-not-admitted",
    });
    expect(host.acquireExecutor({ kind: "headless" }, acquire)).toMatchObject({
      verdict: "refused",
      issue: "connection-not-admitted",
    });
    expect(acquisitions).toBe(1);
    expect(host.state().executions.queued?.kind).toBe("requested");
  } finally {
    publisher.close();
    host.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("publication holds later delivery while an earlier receipt and response settle without replay", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-delivery-"));
  const binding = {
    generation: crypto.randomUUID(),
    harness: "codex" as const,
    interface: "codex-cli" as const,
    nativeSessionId: "same-session",
    owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
    registrationId: crypto.randomUUID(),
    workingDirectory: root,
  };
  const { paths, secret } = createConversationRecord(root, "delivery", { workingDirectory: root });
  const host = createConversationHost(paths.dir, {
    connectionAuthority: () => binding,
    executorLease: () => true,
    now: () => 1000,
    onEffect: () => {},
    onRecord: () => {},
    ownerPresence: () => true,
    presence: () => false,
  });
  const bind = () => host.writeConnection({ actionId: binding.generation, binding, kind: "bound" });
  const frame = (value: unknown) => host.handleFrame(JSON.stringify(value));
  try {
    expect(
      frame(
        attach({
          conversationId: "delivery",
          secret,
          profile: "headless-session",
          harness: "codex",
        }),
      ).verdict,
    ).toBe("accepted");
    expect(
      host
        .enqueueInput({ id: "earlier", mode: "queue", text: "Already issued" })
        .effects.some((e) => e.type === "send" && e.frame.kind === "input"),
    ).toBe(true);
    expect(host.recordNativePublication().verdict).toBe("accepted");
    expect(host.enqueueInput({ id: "later", mode: "queue", text: "Hold this" }).effects).toEqual(
      [],
    );
    expect(readConnection(paths.dir).state).toBe("delivery-uncertain");
    expect(readConnection(paths.dir).inputs).toMatchObject([
      { inputId: "earlier", state: "delivery-uncertain", outcome: null },
      { inputId: "later", state: "saved", outcome: null },
    ]);
    expect(bind().verdict).toBe("refused");
    const receipt = { kind: "disposition", epoch: 1, inputId: "earlier", outcome: "applied" };
    expect(frame(receipt).verdict).toBe("accepted");
    expect(frame(receipt).verdict).toBe("accepted");
    expect(readConnection(paths.dir).state).toBe("outcome-unknown");
    expect(readConnection(paths.dir).inputs[0]).toMatchObject({ state: "received", outcome: null });
    const done = {
      kind: "event",
      epoch: 1,
      n: 1,
      turnId: "earlier-turn",
      event: { kind: "done", cause: "clean", exitCode: 0 },
    };
    const settled = frame(done);
    expect(settled.verdict).toBe("accepted");
    if (settled.verdict !== "accepted") throw new Error("expected completion");
    expect(settled.effects.some((e) => e.type === "send" && e.frame.kind === "input")).toBe(false);
    expect(frame(done).verdict).toBe("refused");
    const collected = host.collectEffects(0);
    expect(
      collected.entries
        .flatMap((entry) => entry.effects)
        .some((e) => e.type === "send" && e.frame.kind === "input"),
    ).toBe(false);
    host.advanceCursor(collected.goodBytes);
    expect(host.cursor()).toBe(0);
    expect(frame({ kind: "detach", epoch: 1, reason: "shutdown" }).verdict).toBe("accepted");
    expect(readConnection(paths.dir).state).toBe("setup-required");
    expect(bind().verdict).toBe("accepted");
    expect(host.state().inputs.map((input) => input.id)).toEqual(["later"]);
  } finally {
    host.close();
    rmSync(root, { force: true, recursive: true });
  }
});
