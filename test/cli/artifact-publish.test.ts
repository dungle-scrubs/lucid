import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishArtifact } from "../../src/cli/artifact-publish.js";
import { dispatch } from "../../src/cli/dispatch.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { readConnection } from "../../src/store/connection-view.js";
import { openWriter } from "../../src/store/conversation-host.js";
import { managedCandidates } from "../../src/store/managed-readiness.js";
import { registerNativeSession } from "../../src/store/native-registration.js";
import { createConversationRecord } from "../../src/store/store.js";

test("publication remains readable and retries the same record when connection needs setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-"));
  try {
    const request = join(root, "publish.json");
    const records = join(root, "records");
    writeFileSync(
      request,
      JSON.stringify({
        artifact: {
          artifactId: "flow",
          bytes: "<h1>Continuity</h1>",
          contentType: "text/html",
          version: 1,
        },
        creationId: "publication-1",
        serverUrl: "http://127.0.0.1:17454",
        settings: {
          effort: "high",
          harness: "codex",
          model: "test-model",
          profile: "headless-turn",
        },
        workingDirectory: root,
      }),
    );
    const output: string[] = [];
    const args = ["artifact", "publish", "--request", request, "--json"];
    await dispatch(args, { onOutput: (line) => output.push(line), rootDir: records });
    const first = JSON.parse(output[0] ?? "null");
    expect(first.publication.status).toBe("published");
    expect(first.connection).toMatchObject({
      reason: "registration-missing",
      state: "setup-required",
    });
    expect(first.artifactUrl).toBe(`http://127.0.0.1:17454/c/${first.conversationId}/flow`);
    await dispatch(args, { onOutput: (line) => output.push(line), rootDir: records });
    expect(JSON.parse(output[1] ?? "null")).toEqual(first);
    const catalog = conversations(records);
    expect(catalog.list().identities.size).toBe(1);
    const host = openWriter(catalog.dirFor(first.conversationId));
    try {
      expect(host.readArtifact("flow", 1)?.bytes).toBe("<h1>Continuity</h1>");
      expect(host.artifactHeads().get("flow")).toBe(1);
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("publication binds verified registration and detects an open native session without a listener", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-bound-publication-"));
  const owner = { executable: "/native/codex", pid: 123, startedAt: "123:456" };
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registered = registerNativeSession(
      root,
      {
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "native-author",
        owner,
        workingDirectory: root,
      },
      authority,
    );
    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error(registered.reason);
    const result = await publishArtifact(
      {
        artifact: {
          artifactId: "flow",
          bytes: "<h1>Bound</h1>",
          contentType: "text/html",
          version: 1,
        },
        creationId: "bound-publication",
        registration: registered.registration.registrationId,
        serverUrl: "http://127.0.0.1:17454",
        settings: {
          effort: "high",
          harness: "codex",
          model: "test-model",
          profile: "headless-turn",
        },
        workingDirectory: root,
      },
      root,
      authority,
    );
    expect(result.connection).toMatchObject({
      message: "Your interactive session is still open. Tell it to resume listening.",
      nativeSessionId: "native-author",
      state: "not-listening",
    });
    const host = openWriter(conversations(root).dirFor(result.conversationId));
    try {
      expect(host.state().connection?.binding.nativeSessionId).toBe("native-author");
      expect(host.readArtifact("flow", 1)?.bytes).toBe("<h1>Bound</h1>");
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a different artifact working folder refuses connection while preserving publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-folder-"));
  const other = join(root, ".other");
  mkdirSync(other);
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registered = registerNativeSession(
      root,
      {
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "native-author",
        owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
        workingDirectory: root,
      },
      authority,
    );
    if (!registered.ok) throw new Error(registered.reason);
    const result = await publishArtifact(
      {
        artifact: {
          artifactId: "flow",
          bytes: "<h1>Keep this</h1>",
          contentType: "text/html",
          version: 1,
        },
        creationId: "wrong-folder",
        registration: registered.registration.registrationId,
        serverUrl: "http://127.0.0.1:17454",
        settings: {
          effort: "high",
          harness: "codex",
          model: "test-model",
          profile: "headless-turn",
        },
        workingDirectory: other,
      },
      root,
      authority,
    );
    expect(result.publication.status).toBe("published");
    expect(result.connection.reason).toBe("connection-folder-mismatch");
    const host = openWriter(conversations(root).dirFor(result.conversationId));
    try {
      expect(host.state().connection).toBeNull();
      expect(host.readArtifact("flow", 1)?.bytes).toBe("<h1>Keep this</h1>");
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("publication and connection status distinguish invalid requests from missing records", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-errors-"));
  try {
    const artifact = {
      artifactId: "flow",
      bytes: "<h1>Flow</h1>",
      contentType: "text/html",
      version: 1,
    };
    const request = { artifact, conversationId: "missing", serverUrl: "http://127.0.0.1:17454" };
    await expect(publishArtifact(request, root)).rejects.toMatchObject({
      code: "E-HUB-03",
      status: 404,
    });
    await expect(
      publishArtifact({ ...request, conversationId: "bad/id" }, root),
    ).rejects.toMatchObject({ code: "E-HUB-03", status: 400 });
    await expect(
      dispatch(["connection", "status", "missing", "--json"], { rootDir: root }),
    ).rejects.toMatchObject({ code: "E-HUB-03", status: 404 });
    const invalidRequest = join(root, ".invalid.json");
    writeFileSync(invalidRequest, "not JSON");
    await expect(
      dispatch(["artifact", "publish", "--request", invalidRequest], { rootDir: root }),
    ).rejects.toMatchObject({ code: "E-HUB-03", status: 400 });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("unverified native ownership remains unknown in the publication result", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-unknown-"));
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registered = registerNativeSession(
      root,
      {
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "native-one",
        owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
        workingDirectory: root,
      },
      authority,
    );
    expect(registered.ok).toBe(true);
    const result = await publishArtifact(
      {
        artifact: {
          artifactId: "flow",
          bytes: "<h1>Keep this</h1>",
          contentType: "text/html",
          version: 1,
        },
        creationId: "unknown-owner",
        serverUrl: "http://127.0.0.1:17454",
        settings: {
          effort: "high",
          harness: "codex",
          model: "test-model",
          profile: "headless-turn",
        },
        workingDirectory: root,
      },
      root,
      { callerOwns: () => undefined, ownerPresence: () => true },
    );
    expect(result.publication.status).toBe("published");
    expect(result.connection).toMatchObject({ reason: "owner-unknown", state: "owner-unknown" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("failed native publication holds saved feedback and retains its cause after reopening", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-hold-"));
  try {
    const result = await publishArtifact(
      {
        artifact: {
          artifactId: "flow",
          bytes: "<h1>Keep feedback here</h1>",
          contentType: "text/html",
          version: 1,
        },
        creationId: "held-publication",
        serverUrl: "http://127.0.0.1:17454",
        settings: {
          effort: "high",
          harness: "codex",
          model: "test-model",
          profile: "headless-turn",
        },
        workingDirectory: root,
      },
      root,
      { callerOwns: () => false, ownerPresence: () => false },
    );
    const dir = conversations(root).dirFor(result.conversationId);
    const host = openWriter(dir);
    try {
      expect(
        host.acceptInput(
          { id: "saved-feedback", mode: "queue", text: "Revise this" },
          { managed: true },
        ).verdict,
      ).toBe("accepted");
    } finally {
      host.close();
    }
    const reopened = openWriter(dir);
    try {
      expect(managedCandidates(dir, reopened.state())).toEqual([]);
      expect(reopened.state().inputs.map((input) => input.id)).toEqual(["saved-feedback"]);
      expect(reopened.readArtifact("flow", 1)?.bytes).toBe("<h1>Keep feedback here</h1>");
      expect(readConnection(dir)).toMatchObject({
        actions: ["setup-instructions"],
        nativeConnectionRequired: true,
        nativeSessionId: null,
        reason: "registration-missing",
        state: "setup-required",
      });
      expect(readConnection(dir).message).toContain(result.connection.message);
      expect(result.connection).toMatchObject({ persistence: "saved" });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("failure to persist diagnostics preserves the successful publication result and durable hold", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-diagnostic-fault-"));
  const { paths } = createConversationRecord(root, "diagnostic-fault", { workingDirectory: root });
  const backup = `${paths.logPath}.saved`;
  let faulted = false;
  try {
    const registered = registerNativeSession(
      root,
      {
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "native-fault",
        owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
        workingDirectory: root,
      },
      { callerOwns: () => true, ownerPresence: () => true },
    );
    if (!registered.ok) throw new Error(registered.reason);
    // Inject a real filesystem failure only after artifact persistence, during native lookup.
    const result = await publishArtifact(
      {
        artifact: {
          artifactId: "flow",
          bytes: "<h1>Saved before fault</h1>",
          contentType: "text/html",
          version: 1,
        },
        conversationId: "diagnostic-fault",
        serverUrl: "http://127.0.0.1:17454",
      },
      root,
      {
        callerOwns: () => {
          if (!faulted) {
            renameSync(paths.logPath, backup);
            mkdirSync(paths.logPath);
            faulted = true;
          }
          return false;
        },
        ownerPresence: () => true,
      },
    );
    expect(faulted).toBe(true);
    expect(result).toMatchObject({
      publication: { status: "published", version: 1 },
      connection: {
        persistence: "unverified",
        reason: "connection-result-unrecorded",
        state: "setup-required",
      },
    });
    rmSync(paths.logPath, { recursive: true });
    renameSync(backup, paths.logPath);
    faulted = false;
    const host = openWriter(paths.dir);
    try {
      expect(host.readArtifact("flow", 1)?.bytes).toBe("<h1>Saved before fault</h1>");
      expect(readConnection(paths.dir)).toMatchObject({
        nativeConnectionRequired: true,
        reason: "publication-connection-incomplete",
      });
    } finally {
      host.close();
    }
  } finally {
    if (faulted) {
      rmSync(paths.logPath, { recursive: true });
      renameSync(backup, paths.logPath);
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("an interrupted native publication remains held and repair preserves saved artifact bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-publication-interrupted-"));
  const { paths } = createConversationRecord(root, "interrupted", { workingDirectory: root });
  try {
    const writer = openWriter(paths.dir);
    expect(writer.recordNativePublication().verdict).toBe("accepted");
    writer.close();
    expect(readConnection(paths.dir)).toMatchObject({
      nativeConnectionRequired: true,
      reason: "publication-connection-incomplete",
      nativeSessionId: null,
    });
    const request = {
      artifact: {
        artifactId: "flow",
        bytes: "<h1>Recovered draft</h1>",
        contentType: "text/html",
        version: 1,
      },
      conversationId: "interrupted",
      serverUrl: "http://127.0.0.1:17454",
    };
    const first = await publishArtifact(request, root, {
      callerOwns: () => false,
      ownerPresence: () => false,
    });
    const saved = openWriter(paths.dir);
    const seq = saved.state().seq;
    saved.close();
    expect(
      await publishArtifact(request, root, { callerOwns: () => false, ownerPresence: () => false }),
    ).toEqual(first);
    await expect(
      publishArtifact(
        { ...request, artifact: { ...request.artifact, bytes: "<h1>Conflicting version</h1>" } },
        root,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const reopened = openWriter(paths.dir);
    try {
      expect(reopened.state().seq).toBe(seq);
      expect(reopened.readArtifact("flow", 1)?.bytes).toBe(request.artifact.bytes);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
