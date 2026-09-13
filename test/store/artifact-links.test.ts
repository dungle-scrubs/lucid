import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWriter } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

const linkDocument = (body: string): string =>
  `<!doctype html><html><head><meta name="lucid-theme" content="adaptive"></head><body>${body}</body></html>`;

test("agent admission refuses a missing fragment and retains the previous version", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-links-"));
  createConversationRecord(root, "test");
  const host = openWriter(join(root, "test"));
  try {
    const previous = await host.writeArtifact({
      artifactId: "doc",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: linkDocument("<h1>Original</h1>"),
    });
    expect(previous.verdict).toBe("accepted");
    const result = await host.writeArtifact({
      artifactId: "doc",
      version: 2,
      author: "agent",
      contentType: "text/html",
      bytes: linkDocument('<a href="#missing">Jump</a>'),
    });
    expect(result.verdict).toBe("refused");
    expect(host.artifactHeads().get("doc")).toBe(1);
    expect(host.readArtifact("doc", 2)).toBeNull();
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote validation is required for standalone agent writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-links-"));
  createConversationRecord(root, "test");
  const seen: string[] = [];
  const host = openWriter(join(root, "test"), {
    probeArtifactLink: async (url) => {
      seen.push(url);
      return { status: "broken", reason: "HTTP 404" };
    },
  });
  try {
    const result = await host.writeArtifact({
      artifactId: "doc",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: linkDocument('<a href="https://example.com/missing">Source</a>'),
    });
    expect(result).toMatchObject({ verdict: "refused", issue: "artifact-link-broken" });
    expect(seen).toEqual(["https://example.com/missing"]);
    expect(host.artifactHeads().size).toBe(0);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a human save during a web check wins without being overwritten", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-links-"));
  createConversationRecord(root, "test");
  const deferred = Promise.withResolvers<{ status: "valid" }>();
  const host = openWriter(join(root, "test"), { probeArtifactLink: () => deferred.promise });
  const other = openWriter(join(root, "test"));
  try {
    await host.writeArtifact({
      artifactId: "doc",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: linkDocument("<p>Original</p>"),
    });
    const pending = host.writeArtifact({
      artifactId: "doc",
      version: 2,
      author: "agent",
      contentType: "text/html",
      bytes: linkDocument('<a href="https://example.com/">Source</a>'),
    });
    const human = await other.writeArtifact({
      artifactId: "doc",
      version: 2,
      author: "human",
      contentType: "text/html",
      bytes: "<p>Human save</p>",
    });
    expect(human.verdict).toBe("accepted");
    deferred.resolve({ status: "valid" });
    expect(await pending).toMatchObject({ verdict: "refused", issue: "artifact-version-exists" });
    expect(host.readArtifact("doc", 2)?.bytes).toBe("<p>Human save</p>");
  } finally {
    host.close();
    other.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["caller", "writer"])("%s cancellation prevents a late append", async (by) => {
  const root = mkdtempSync(join(tmpdir(), "lucid-links-"));
  createConversationRecord(root, "test");
  const deferred = Promise.withResolvers<{ status: "valid" }>();
  const host = openWriter(join(root, "test"), { probeArtifactLink: () => deferred.promise });
  const controller = new AbortController();
  try {
    const pending = host.writeArtifact({
      artifactId: "doc",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: linkDocument('<a href="https://example.com/">Source</a>'),
      signal: controller.signal,
    });
    if (by === "writer") host.close();
    else controller.abort();
    expect(await pending).toMatchObject({ verdict: "refused", issue: "artifact-link-unverified" });
    deferred.resolve({ status: "valid" });
    expect(host.readArtifact("doc", 1)).toBeNull();
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
