import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { replaceLocation, replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";

test("a newer artifact invalidates prepared dispatch even when the conversation sequence is unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-dispatch-context-"));
  const { paths, secret } = createConversationRecord(root, "dispatch");
  const host = createConversationHost(paths.dir, {
    now: () => 1,
    presence: () => false,
    executorLease: () => true,
    onEffect: () => {},
    onRecord: () => {},
  });
  try {
    host.acceptInput(
      { id: "request", text: "Revise the current document", mode: "queue" },
      { managed: true },
    );
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "dispatch",
        secret,
        version: 1,
        harness: "claude",
        profile: "headless-turn",
        capabilities: ["managed-input-v1"],
        attachmentOrigin: "automatic",
      }),
    );
    host.writeArtifact({
      artifactId: "doc",
      version: 1,
      author: "user",
      contentType: "text/plain",
      bytes: "Original document",
    });
    const captured = host.captureDispatch("request", 0);
    const seq = host.state().seq;
    host.writeArtifact({
      artifactId: "doc",
      version: 2,
      author: "user",
      contentType: "text/plain",
      bytes: "Revised while the summary was running",
    });
    expect(host.state().seq).toBe(seq);
    const attempt = {
      kind: "attempt-started" as const,
      inputId: "request",
      attempt: 1,
      epoch: captured.epoch,
      turnId: "turn-1",
      driver: {
        harness: "claude" as const,
        model: "selected",
        effort: "high",
        profile: "headless-turn" as const,
      },
      native: { kind: "fresh" as const },
      context: {
        digest: captured.context.digest,
        from: captured.context.from,
        through: captured.context.through,
      },
    };
    expect(host.writePreparedExecution(attempt, captured.stamp)).toMatchObject({
      verdict: "refused",
      issue: "execution-stale",
    });
    expect(host.state().executions.request?.kind).toBe("requested");
    const refreshed = host.captureDispatch("request", 0);
    expect(refreshed.context.mandatory[0]?.text).toBe("Revised while the summary was running");
    expect(
      host.writePreparedExecution(
        {
          ...attempt,
          context: {
            digest: refreshed.context.digest,
            from: refreshed.context.from,
            through: refreshed.context.through,
          },
        },
        refreshed.stamp,
      ).verdict,
    ).toBe("accepted");
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["settings", "folder", "input", "lease", "cursor", "range"])(
  "dispatch rechecks %s changes and ignores content-neutral cursors",
  (change) => {
    const root = mkdtempSync(join(tmpdir(), "lucid-dispatch-race-"));
    const { paths, secret } = createConversationRecord(root, "dispatch");
    let held = true;
    const deps = {
      now: () => 1,
      presence: () => false,
      executorLease: () => held,
      onEffect: () => {},
      onRecord: () => {},
    };
    const host = createConversationHost(paths.dir, deps);
    const writer = createConversationHost(paths.dir, { ...deps, executorLease: () => false });
    try {
      host.acceptInput({ id: "request", text: "Continue", mode: "queue" }, { managed: true });
      host.handleFrame(
        JSON.stringify({
          kind: "attach",
          conversationId: "dispatch",
          secret,
          version: 1,
          harness: "claude",
          profile: "headless-turn",
          capabilities: ["managed-input-v1"],
          attachmentOrigin: "automatic",
        }),
      );
      const captured = host.captureDispatch("request", 0);
      if (change === "settings")
        replaceSettings(paths.dir, "dispatch", 0, {
          harness: "claude",
          model: "changed",
          effort: "high",
          profile: "headless-turn",
        });
      if (change === "folder") replaceLocation(paths.dir, "dispatch", 0, root);
      if (change === "input")
        writer.acceptInput(
          { id: "later", text: "A new constraint", mode: "queue" },
          { managed: true },
        );
      if (change === "lease") held = false;
      if (change === "cursor") host.advanceCursor(host.collectEffects(0).goodBytes);
      expect(
        host.writePreparedExecution(
          {
            kind: "attempt-started",
            inputId: "request",
            attempt: 1,
            epoch: captured.epoch,
            turnId: "turn-1",
            driver: {
              harness: "claude",
              model: "selected",
              effort: "high",
              profile: "headless-turn",
            },
            native: { kind: "fresh" },
            context: {
              digest: captured.context.digest,
              from: change === "range" ? captured.context.from + 1 : captured.context.from,
              through: captured.context.through,
            },
          },
          captured.stamp,
        ).verdict,
      ).toBe(change === "cursor" ? "accepted" : "refused");
      expect(host.state().executions.request?.kind).toBe(
        change === "cursor" ? "attempt-started" : "requested",
      );
    } finally {
      writer.close();
      host.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
