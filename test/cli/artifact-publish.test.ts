import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishArtifact } from "../../src/cli/artifact-publish.js";
import { dispatch } from "../../src/cli/dispatch.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { openWriter } from "../../src/store/conversation-host.js";
import { registerNativeSession } from "../../src/store/native-registration.js";

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
