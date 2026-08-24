import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactKey, foldLog, hashArtifactBytes } from "../../src/store/log.js";
import { createConversationRecord, openConversation, StoreError } from "../../src/store/store.js";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "lucid-artifact-"));
const recordDir = (root: string, id: string): string => join(root, id);

describe("artifact versions (RFC-06 storage)", () => {
  test("an artifact version is its own log entry, carrying id, version, author, contentType, hash, bytes", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const host = openConversation(recordDir(root, "conv-1"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    const res = host.writeArtifact({
      artifactId: "doc-1",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "<h1>hello</h1>",
    });
    expect(res.verdict).toBe("accepted");
    if (res.verdict === "accepted") {
      expect(res.version.artifactId).toBe("doc-1");
      expect(res.version.version).toBe(1);
      expect(res.version.author).toBe("agent");
      expect(res.version.contentType).toBe("text/html");
      expect(res.version.hash).toBe(hashArtifactBytes("<h1>hello</h1>"));
      expect(res.version.bytes).toBe("<h1>hello</h1>");
    }
    // Raw log contains the entry with all fields
    const raw = readFileSync(join(root, "conv-1", "log.ndjson"), "utf8");
    const entry = JSON.parse(raw.trim().split("\n")[0] ?? "") as Record<string, unknown>;
    expect(entry.src).toBe("artifact");
    expect(entry.artifactId).toBe("doc-1");
    expect((entry as { version: number }).version).toBe(1);
    expect(entry.author).toBe("agent");
    expect(entry.contentType).toBe("text/html");
    expect(typeof entry.hash).toBe("string");
    expect(entry.bytes).toBe("<h1>hello</h1>");
    host.close();
  });

  test("folding a record does not pull artifact bytes into state or transcript", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const host = openConversation(recordDir(root, "conv-1"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    const before = host.state();
    host.writeArtifact({
      artifactId: "doc-1",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "<p>big</p>",
    });
    const after = host.state();
    // State seq unchanged — artifacts are not reduced
    expect(after.seq).toBe(before.seq);
    expect(after.epoch).toBe(before.epoch);
    const tr = host.transcript();
    expect(tr.events.length).toBe(0);
    expect(tr.inputs.length).toBe(0);
    // Transcript string should not contain artifact bytes
    expect(JSON.stringify(tr)).not.toContain("<p>big</p>");
    host.close();
  });

  test("reading a version is a seek, not a fold — index built during fold at open", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const host = openConversation(recordDir(root, "conv-1"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    host.writeArtifact({
      artifactId: "doc-1",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "v1",
    });
    host.writeArtifact({
      artifactId: "doc-1",
      version: 2,
      author: "agent",
      contentType: "text/html",
      bytes: "v2",
    });
    host.writeArtifact({
      artifactId: "doc-1",
      version: 3,
      author: "human",
      contentType: "text/html",
      bytes: "v3",
    });
    // Index built during fold at open — available immediately, no extra fold for read
    const idx = host.artifactIndex();
    expect(idx.size).toBe(3);
    expect(idx.has(artifactKey("doc-1", 2))).toBe(true);
    // Reading v2 via seek returns exact bytes
    const v2 = host.readArtifact("doc-1", 2);
    expect(v2?.bytes).toBe("v2");
    expect(v2?.version).toBe(2);
    expect(v2?.hash).toBe(hashArtifactBytes("v2"));
    host.close();
  });

  test("reopening a record returns the same versions, unchanged", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const host = openConversation(recordDir(root, "conv-1"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    host.writeArtifact({
      artifactId: "doc-1",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "first",
    });
    host.writeArtifact({
      artifactId: "doc-1",
      version: 2,
      author: "agent",
      contentType: "text/html",
      bytes: "second",
    });
    host.writeArtifact({
      artifactId: "doc-1",
      version: 3,
      author: "human",
      contentType: "text/html",
      bytes: "third",
    });
    host.close();

    const host2 = openConversation(recordDir(root, "conv-1"), {
      now: () => 2_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    const v1 = host2.readArtifact("doc-1", 1);
    const v2 = host2.readArtifact("doc-1", 2);
    const v3 = host2.readArtifact("doc-1", 3);
    expect(v1?.bytes).toBe("first");
    expect(v2?.bytes).toBe("second");
    expect(v3?.bytes).toBe("third");
    expect(v2?.hash).toBe(hashArtifactBytes("second"));
    // Versions are unchanged after reopen
    expect(v1?.hash).toBe(hashArtifactBytes("first"));
    expect(v3?.hash).toBe(hashArtifactBytes("third"));
    host2.close();
  });

  test("nothing is ever rewritten — every version is a new entry, duplicate version keeps first", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const host = openConversation(recordDir(root, "conv-1"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    host.writeArtifact({
      artifactId: "doc-1",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "original",
    });
    const rawBefore = readFileSync(join(root, "conv-1", "log.ndjson"), "utf8");
    // Attempt to write same (id, version) with different bytes — should keep first
    host.writeArtifact({
      artifactId: "doc-1",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "replaced",
    });
    const rawAfter = readFileSync(join(root, "conv-1", "log.ndjson"), "utf8");
    // Log length unchanged — nothing rewritten, no new entry for duplicate
    expect(rawAfter).toBe(rawBefore);
    expect(host.readArtifact("doc-1", 1)?.bytes).toBe("original");
    // New version appends
    host.writeArtifact({
      artifactId: "doc-1",
      version: 2,
      author: "agent",
      contentType: "text/html",
      bytes: "next",
    });
    expect(host.readArtifact("doc-1", 2)?.bytes).toBe("next");
    expect(host.readArtifact("doc-1", 1)?.bytes).toBe("original");
    host.close();
  });

  test("a version over the size limit is refused, and the record still opens", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const host = openConversation(recordDir(root, "conv-1"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    const big = "x".repeat(1_000_001);
    const res = host.writeArtifact({
      artifactId: "doc-1",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: big,
    });
    expect(res.verdict).toBe("refused");
    if (res.verdict === "refused") expect(res.issue).toBe("artifact-too-large");
    // Refused oversize leaves no index entry
    expect(host.readArtifact("doc-1", 1)).toBeNull();
    host.close();

    // Fixture-written oversize entry: record still opens, oversize not indexed
    const root2 = freshRoot();
    createConversationRecord(root2, "conv-2");
    const hash = hashArtifactBytes(big);
    const line = JSON.stringify({
      v: 1,
      at: 2_000,
      src: "artifact",
      artifactId: "doc-2",
      version: 1,
      author: "agent",
      contentType: "text/html",
      hash,
      bytes: big,
    });
    appendFileSync(join(root2, "conv-2", "log.ndjson"), `${line}\n`);
    // Valid version after oversize still folds
    const smallHash = hashArtifactBytes("ok");
    const line2 = JSON.stringify({
      v: 1,
      at: 3_000,
      src: "artifact",
      artifactId: "doc-2",
      version: 2,
      author: "agent",
      contentType: "text/html",
      hash: smallHash,
      bytes: "ok",
    });
    appendFileSync(join(root2, "conv-2", "log.ndjson"), `${line2}\n`);
    const host2 = openConversation(recordDir(root2, "conv-2"), {
      now: () => 4_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    // Oversize not readable, but valid later version is
    expect(host2.readArtifact("doc-2", 1)).toBeNull();
    expect(host2.readArtifact("doc-2", 2)?.bytes).toBe("ok");
    const raw = readFileSync(join(root2, "conv-2", "log.ndjson"));
    const folded = foldLog(
      "conv-2",
      readFileSync(join(root2, "conv-2", "secret"), "utf8").trim(),
      raw,
    );
    expect(folded.artifactRefusals.length).toBe(1);
    expect(folded.artifactRefusals[0]?.issue).toBe("artifact-too-large");
    host2.close();
  });

  test("the hash is written for every version from the first — missing hash is corrupt", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    // Fixture without hash
    const line = JSON.stringify({
      v: 1,
      at: 1_000,
      src: "artifact",
      artifactId: "doc-1",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "hi",
    });
    appendFileSync(join(root, "conv-1", "log.ndjson"), `${line}\n`);
    expect(() =>
      openConversation(recordDir(root, "conv-1"), {
        now: () => 2_000,
        presence: () => undefined,
        executorLease: () => true,
        onEffect: () => {},
        onRecord: () => {},
      }),
    ).toThrow(StoreError);

    // With hash it opens
    const root2 = freshRoot();
    createConversationRecord(root2, "conv-2");
    const hash = hashArtifactBytes("hi");
    const line2 = JSON.stringify({
      v: 1,
      at: 1_000,
      src: "artifact",
      artifactId: "doc-2",
      version: 1,
      author: "agent",
      contentType: "text/html",
      hash,
      bytes: "hi",
    });
    appendFileSync(join(root2, "conv-2", "log.ndjson"), `${line2}\n`);
    const host2 = openConversation(recordDir(root2, "conv-2"), {
      now: () => 2_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host2.readArtifact("doc-2", 1)?.hash).toBe(hash);
    // Cannot be added later — reopening still sees the original with hash
    host2.close();
    const host3 = openConversation(recordDir(root2, "conv-2"), {
      now: () => 3_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(host3.readArtifact("doc-2", 1)?.hash).toBe(hash);
    host3.close();
  });

  test("write three versions, close, reopen, read version two (ticket proof)", () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-proof");
    const host = openConversation(recordDir(root, "conv-proof"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    host.writeArtifact({
      artifactId: "proof-doc",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "<p>one</p>",
    });
    host.writeArtifact({
      artifactId: "proof-doc",
      version: 2,
      author: "agent",
      contentType: "text/html",
      bytes: "<p>two</p>",
    });
    host.writeArtifact({
      artifactId: "proof-doc",
      version: 3,
      author: "human",
      contentType: "text/html",
      bytes: "<p>three</p>",
    });
    host.close();

    const host2 = openConversation(recordDir(root, "conv-proof"), {
      now: () => 2_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    const v2 = host2.readArtifact("proof-doc", 2);
    expect(v2).not.toBeNull();
    expect(v2?.bytes).toBe("<p>two</p>");
    expect(v2?.version).toBe(2);
    expect(v2?.artifactId).toBe("proof-doc");
    host2.close();
  });

  test("a version that already exists is idempotent for the same bytes and refused for different ones", () => {
    // The first cut returned the existing version with verdict "accepted"
    // whatever the caller passed, which discards their content and reports
    // success. If lucid ever computes the next version wrongly, that loses
    // an artifact version silently.
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const host = openConversation(recordDir(root, "conv-1"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    const write = (version: number, bytes: string) =>
      host.writeArtifact({
        artifactId: "a1",
        version,
        author: "agent",
        contentType: "text/html",
        bytes,
      });

    expect(write(1, "<p>one</p>").verdict).toBe("accepted");

    // Same bytes again: accepted, so a retry after a crash between the write
    // and its acknowledgement does not force a new version number.
    const again = write(1, "<p>one</p>");
    expect(again.verdict).toBe("accepted");

    // Different bytes: refused, and the stored version is untouched.
    const clash = write(1, "<p>something else</p>");
    expect(clash.verdict).toBe("refused");
    if (clash.verdict === "refused") expect(clash.issue).toBe("artifact-version-exists");
    expect(host.readArtifact("a1", 1)?.bytes).toBe("<p>one</p>");
  });
});
