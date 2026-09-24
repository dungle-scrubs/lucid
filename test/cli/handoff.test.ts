import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandoff } from "../../src/cli/handoff.js";
import { parseHandoffRequest, readHandoffRequest } from "../../src/cli/handoff-request.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { HubError } from "../../src/protocol/hub-errors.js";
import { openWriter } from "../../src/store/conversation-host.js";
import { managedCandidates } from "../../src/store/managed-readiness.js";
import { presenceHeld } from "../../src/store/presence.js";

const requestFile = (dir: string, overrides: Record<string, unknown> = {}) => {
  const path = join(dir, "handoff.json");
  writeFileSync(
    path,
    JSON.stringify({
      artifact: {
        artifactId: "walkthrough",
        bytes: "<h1>Handoff</h1>",
        contentType: "text/html",
        version: 1,
      },
      continuation: { inputId: "continue-1", text: "Review this document." },
      creationId: "handoff-roundtrip-1",
      serverUrl: "http://127.0.0.1:17454",
      settings: {
        effort: "high",
        harness: "codex",
        model: "test-model",
        profile: "headless-turn",
      },
      workingDirectory: dir,
      ...overrides,
    }),
  );
  return path;
};

test("handoff round trip: record, artifact, continuation, URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  try {
    const records = join(root, "records");
    const parsed = parseHandoffRequest(await readHandoffRequest(requestFile(root)));
    const result = await runHandoff(parsed, records);
    expect(result.publication.status).toBe("published");
    expect(result.artifactUrl).toBe(
      `http://127.0.0.1:17454/c/${result.conversationId}/walkthrough`,
    );
    expect(result.continuation.inputId).toBe("continue-1");
    const host = openWriter(conversations(records).dirFor(result.conversationId));
    try {
      expect(host.readArtifact("walkthrough", 1)?.bytes).toBe("<h1>Handoff</h1>");
      const inputs = host.snapshot().transcript.inputs;
      expect(inputs.some((input) => input.id === "continue-1")).toBe(true);
      expect(
        managedCandidates(
          conversations(records).dirFor(result.conversationId),
          host.state(),
          host.artifactHeads(),
        ),
      ).toContain("continue-1");
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical retry returns the same conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  try {
    const records = join(root, "records");
    const path = requestFile(root);
    const first = await runHandoff(parseHandoffRequest(await readHandoffRequest(path)), records);
    const second = await runHandoff(parseHandoffRequest(await readHandoffRequest(path)), records);
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.artifactUrl).toBe(first.artifactUrl);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting continuation text on the same input id is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  try {
    const records = join(root, "records");
    const path = requestFile(root);
    await runHandoff(parseHandoffRequest(await readHandoffRequest(path)), records);
    const conflict = parseHandoffRequest(
      await readHandoffRequest(
        requestFile(root, { continuation: { inputId: "continue-1", text: "Different text." } }),
      ),
    );
    await expect(runHandoff(conflict, records)).rejects.toThrow("different text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch runs handoff and prints the URL", async () => {
  const { dispatch } = await import("../../src/cli/dispatch.js");
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  try {
    const records = join(root, "records");
    const path = requestFile(root, { creationId: "handoff-dispatch-1" });
    const output: string[] = [];
    await dispatch(["handoff", "--request", path, "--json"], {
      onOutput: (line: string) => output.push(line),
      rootDir: records,
    });
    const result = JSON.parse(output[0] ?? "null");
    expect(result.publication.status).toBe("published");
    expect(result.artifactUrl).toContain("/walkthrough");
    expect(result.continuation.inputId).toBe("continue-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed handoff stays readable and eligible before attach", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  try {
    const records = join(root, "records");
    const path = requestFile(root, { creationId: "handoff-adopt-1" });
    const { parseHandoffRequest: parse, readHandoffRequest: read } = await import(
      "../../src/cli/handoff-request.js"
    );
    const first = await runHandoff(parse(await read(path)), records);
    // No source attached yet. A fresh reader sees the artifact and the
    // queued continuation as an ordinary candidate.
    const dir = conversations(records).dirFor(first.conversationId);
    const host = openWriter(dir);
    try {
      expect(host.readArtifact("walkthrough", 1)?.bytes).toBe("<h1>Handoff</h1>");
      expect(managedCandidates(dir, host.state(), host.artifactHeads())).toContain("continue-1");
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry with a fresh continuation id is refused E-HUB-02", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  try {
    const records = join(root, "records");
    const path = requestFile(root, { creationId: "handoff-fresh-id-1" });
    const { parseHandoffRequest: parse, readHandoffRequest: read } = await import(
      "../../src/cli/handoff-request.js"
    );
    await runHandoff(parse(await read(path)), records);
    const retry = parse(
      await read(
        requestFile(root, {
          continuation: { inputId: "continue-2", text: "Other task." },
          creationId: "handoff-fresh-id-1",
        }),
      ),
    );
    const failure = await runHandoff(retry, records).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(HubError);
    expect((failure as HubError).code).toBe("E-HUB-02");
    const catalog = conversations(records);
    const ids = [...catalog.list().identities.keys()];
    expect(ids.length).toBe(1);
    const host = openWriter(catalog.dirFor(ids[0] as string));
    try {
      expect(host.snapshot().transcript.inputs.length).toBe(1);
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry with differing artifact bytes is refused E-HUB-02", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  try {
    const records = join(root, "records");
    const path = requestFile(root, { creationId: "handoff-diff-bytes-1" });
    const { parseHandoffRequest: parse, readHandoffRequest: read } = await import(
      "../../src/cli/handoff-request.js"
    );
    await runHandoff(parse(await read(path)), records);
    const retry = parse(
      await read(
        requestFile(root, {
          artifact: {
            artifactId: "walkthrough",
            bytes: "<h1>Changed</h1>",
            contentType: "text/html",
            version: 1,
          },
          creationId: "handoff-diff-bytes-1",
        }),
      ),
    );
    const failure = await runHandoff(retry, records).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(HubError);
    expect((failure as HubError).code).toBe("E-HUB-02");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical retry appends no second input", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-handoff-"));
  try {
    const records = join(root, "records");
    const path = requestFile(root, { creationId: "handoff-nodupe-1" });
    const { parseHandoffRequest: parse, readHandoffRequest: read } = await import(
      "../../src/cli/handoff-request.js"
    );
    const first = await runHandoff(parse(await read(path)), records);
    expect(first.continuation.idempotent).toBe(false);
    const second = await runHandoff(parse(await read(path)), records);
    expect(second.continuation.idempotent).toBe(true);
    expect(second.continuation.seq).toBe(first.continuation.seq);
    const host = openWriter(conversations(records).dirFor(first.conversationId));
    try {
      expect(host.snapshot().transcript.inputs.length).toBe(1);
      expect(presenceHeld(conversations(records).dirFor(first.conversationId))).toBe(false);
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
