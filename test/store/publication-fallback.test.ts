import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessOwner } from "../../src/process-owner.js";
import { requiresNativeConnection } from "../../src/protocol/connection.js";
import { readConnection } from "../../src/store/connection-view.js";
import { createConversationHost, openWriter } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";
import { attach } from "../protocol/helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const missing = {
  message: "No verified native registration matches this process.",
  reason: "registration-missing",
};

function record(): string {
  return recordIn().dir;
}

function recordIn(): { readonly dir: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-fallback-"));
  roots.push(root);
  const { paths } = createConversationRecord(root, crypto.randomUUID(), { workingDirectory: root });
  return { dir: paths.dir, root };
}

test("a registration-missing failure admits a terminal fallback; an identical repeat changes nothing", () => {
  const host = openWriter(record());
  try {
    expect(host.recordNativePublication().verdict).toBe("accepted");
    expect(host.recordNativePublication(missing).verdict).toBe("accepted");
    expect(requiresNativeConnection(host.state())).toBe(true);
    expect(host.recordPublicationFallback().verdict).toBe("accepted");
    const after = host.state();
    expect(after.nativePublication?.fallback?.failureActionId).toBe(
      after.nativePublication?.failure?.actionId,
    );
    expect(requiresNativeConnection(after)).toBe(false);
    expect(host.recordPublicationFallback().verdict).toBe("accepted");
    expect(host.state().seq).toBe(after.seq);
  } finally {
    host.close();
  }
});

test("every other failure reason, and no failure at all, keeps the hold", () => {
  for (const reason of [
    "owner-unknown",
    "native-identity-conflict",
    "invalid-registration",
    "registration-busy",
  ]) {
    const host = openWriter(record());
    try {
      host.recordNativePublication();
      expect(host.recordPublicationFallback()).toMatchObject({
        issue: "connection-not-admitted",
        verdict: "refused",
      });
      host.recordNativePublication({ message: `failed: ${reason}`, reason });
      expect(host.recordPublicationFallback()).toMatchObject({
        issue: "connection-not-admitted",
        verdict: "refused",
      });
      expect(requiresNativeConnection(host.state())).toBe(true);
    } finally {
      host.close();
    }
  }
});

test("a fallback that does not name the current failure is refused", () => {
  const host = openWriter(record());
  try {
    host.recordNativePublication();
    host.recordNativePublication(missing);
    expect(
      host.writeConnection({
        actionId: crypto.randomUUID(),
        failureActionId: crypto.randomUUID(),
        kind: "publication-fallback",
      }),
    ).toMatchObject({ issue: "connection-not-admitted", verdict: "refused" });
  } finally {
    host.close();
  }
});

test("an input with unconfirmed legacy delivery blocks the fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-fallback-"));
  roots.push(root);
  const { paths, secret } = createConversationRecord(root, "legacy", { workingDirectory: root });
  const host = createConversationHost(paths.dir, {
    connectionAuthority: () => undefined,
    executorLease: () => true,
    now: () => 1000,
    onEffect: () => {},
    onRecord: () => {},
    ownerPresence: () => true,
    presence: () => false,
  });
  try {
    expect(
      host.handleFrame(
        JSON.stringify(
          attach({
            conversationId: "legacy",
            secret,
            profile: "headless-session",
            harness: "codex",
          }),
        ),
      ).verdict,
    ).toBe("accepted");
    expect(
      host
        .enqueueInput({ id: "earlier", mode: "queue", text: "Already issued" })
        .effects.some((e) => e.type === "send" && e.frame.kind === "input"),
    ).toBe(true);
    host.recordNativePublication();
    expect(host.state().nativePublication?.legacyDelivery.uncertainInputs).toEqual(["earlier"]);
    host.recordNativePublication(missing);
    expect(host.recordPublicationFallback()).toMatchObject({
      issue: "execution-blocked",
      verdict: "refused",
    });
    expect(requiresNativeConnection(host.state())).toBe(true);
    expect(readConnection(paths.dir).state).toBe("delivery-uncertain");
  } finally {
    host.close();
  }
});

test("after fallback a binding and a new failure are refused, and a repeated request is a no-op", () => {
  const { dir, root } = recordIn();
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Expected the test process identity");
  const binding = {
    generation: crypto.randomUUID(),
    harness: "codex" as const,
    interface: "codex-cli" as const,
    nativeSessionId: "late-native",
    owner,
    registrationId: crypto.randomUUID(),
    workingDirectory: root,
  };
  const host = openWriter(dir, { connectionAuthority: () => binding, ownerPresence: () => true });
  try {
    host.recordNativePublication();
    host.recordNativePublication(missing);
    host.recordPublicationFallback();
    const settled = host.state().seq;
    expect(host.recordNativePublication().verdict).toBe("accepted");
    expect(host.state().seq).toBe(settled);
    expect(
      host.recordNativePublication({ message: "later", reason: "owner-unknown" }),
    ).toMatchObject({
      issue: "connection-not-admitted",
      verdict: "refused",
    });
    expect(
      host.writeConnection({ actionId: binding.generation, binding, kind: "bound" }),
    ).toMatchObject({
      issue: "connection-conflict",
      verdict: "refused",
    });
    expect(host.state().connection).toBeNull();
  } finally {
    host.close();
  }
});

test("a crash between the failure and the fallback stays held until the same publication repeats", () => {
  const dir = record();
  const crashed = openWriter(dir);
  try {
    crashed.recordNativePublication();
    crashed.recordNativePublication(missing);
  } finally {
    crashed.close();
  }
  const retry = openWriter(dir);
  try {
    expect(requiresNativeConnection(retry.state())).toBe(true);
    const failure = retry.state().nativePublication?.failure?.actionId;
    retry.recordNativePublication();
    retry.recordNativePublication(missing);
    expect(retry.state().nativePublication?.failure?.actionId).toBe(failure);
    expect(retry.recordPublicationFallback().verdict).toBe("accepted");
  } finally {
    retry.close();
  }
  const replayed = openWriter(dir);
  try {
    expect(replayed.state().nativePublication?.fallback?.failureActionId).toBe(
      replayed.state().nativePublication?.failure?.actionId,
    );
    expect(requiresNativeConnection(replayed.state())).toBe(false);
  } finally {
    replayed.close();
  }
});

test("a bound record never falls back", () => {
  const { dir, root } = recordIn();
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Expected the test process identity");
  const binding = {
    generation: crypto.randomUUID(),
    harness: "codex" as const,
    interface: "codex-cli" as const,
    nativeSessionId: "bound-native",
    owner,
    registrationId: crypto.randomUUID(),
    workingDirectory: root,
  };
  const host = openWriter(dir, { connectionAuthority: () => binding, ownerPresence: () => true });
  try {
    host.recordNativePublication();
    expect(
      host.writeConnection({ actionId: binding.generation, binding, kind: "bound" }).verdict,
    ).toBe("accepted");
    host.recordNativePublication(missing);
    expect(host.recordPublicationFallback()).toMatchObject({
      issue: "connection-not-admitted",
      verdict: "refused",
    });
    expect(requiresNativeConnection(host.state())).toBe(true);
  } finally {
    host.close();
  }
});
