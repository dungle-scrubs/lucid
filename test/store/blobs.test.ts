/**
 * The blob store (RFC-11).
 *
 * Two things carry most of the weight here. A blob's name is a hash and is
 * never used as a path - `secret` sits in the same record, so a name that
 * could traverse would be a credential disclosure. And storing is atomic and
 * idempotent, because the log entry that names a blob is appended after it
 * and must never refer to bytes that are half written or absent.
 */
import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_BYTES_MAX } from "../../src/protocol/attachment.js";
import { blobPath, blobSize, getBlob, hasBlob, hashBlob, putBlob } from "../../src/store/blobs.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

const rec = (): string => mkdtempSync(join(tmpdir(), "lucid-blob-"));
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("storing and reading back", () => {
  test("what goes in comes out", () => {
    const dir = rec();
    const hash = putBlob(dir, bytes("hello"));
    expect(new TextDecoder().decode(getBlob(dir, hash) as Uint8Array)).toBe("hello");
  });

  test("the name is the sha256 of the bytes", () => {
    const dir = rec();
    expect(putBlob(dir, bytes("hello"))).toBe(hashBlob(bytes("hello")));
  });

  test("the same bytes stored twice are one file", () => {
    const dir = rec();
    const a = putBlob(dir, bytes("same"));
    const b = putBlob(dir, bytes("same"));
    expect(a).toBe(b);
    expect(readdirSync(join(dir, "files")).length).toBe(1);
  });

  test("different bytes are different files", () => {
    const dir = rec();
    putBlob(dir, bytes("one"));
    putBlob(dir, bytes("two"));
    expect(readdirSync(join(dir, "files")).length).toBe(2);
  });

  test("empty bytes are storable", () => {
    const dir = rec();
    const hash = putBlob(dir, new Uint8Array(0));
    expect(getBlob(dir, hash)?.byteLength).toBe(0);
  });

  test("binary survives unchanged", () => {
    const dir = rec();
    const raw = new Uint8Array([0x89, 0x50, 0x00, 0xff, 0x1f]);
    const hash = putBlob(dir, raw);
    expect([...(getBlob(dir, hash) as Uint8Array)]).toEqual([...raw]);
  });
});

describe("a blob's name is a hash, never a path", () => {
  test("traversal is refused on the shape of the name", () => {
    // `secret` is in this directory. The check happens before the filesystem
    // is touched, so there is nothing to resolve.
    const dir = rec();
    for (const bad of ["../secret", "secret", "..", "", "/etc/passwd", "a".repeat(63)]) {
      expect(() => blobPath(dir, bad)).toThrow();
    }
  });

  test("uppercase hex is not a blob name", () => {
    const dir = rec();
    expect(() => blobPath(dir, "A".repeat(64))).toThrow();
  });

  test("a real hash resolves inside the blob directory", () => {
    const dir = rec();
    const hash = hashBlob(bytes("x"));
    expect(blobPath(dir, hash)).toBe(join(dir, "files", hash));
  });

  test("reading an unknown blob refuses rather than resolving", () => {
    expect(() => getBlob(rec(), "../secret")).toThrow();
  });
});

describe("the bound", () => {
  test("a file over it is refused and nothing is written", () => {
    const dir = rec();
    const tooBig = new Uint8Array(ATTACHMENT_BYTES_MAX + 1);
    expect(() => putBlob(dir, tooBig)).toThrow(/attachment-too-large/);
    // Refused before the bytes are copied, so there is no directory at all.
    expect(existsSync(join(dir, "files"))).toBe(false);
  });

  test("a file exactly at the bound is stored", () => {
    const dir = rec();
    expect(() => putBlob(dir, new Uint8Array(ATTACHMENT_BYTES_MAX))).not.toThrow();
  });
});

describe("what a missing blob does", () => {
  test("reading one is null, not a throw", () => {
    // A record can be copied without its files by someone using the wrong
    // tool. Saying the file is gone beats refusing to open the conversation.
    const dir = rec();
    expect(getBlob(dir, hashBlob(bytes("never stored")))).toBeNull();
    expect(hasBlob(dir, hashBlob(bytes("never stored")))).toBe(false);
    expect(blobSize(dir, hashBlob(bytes("never stored")))).toBeNull();
  });

  test("a blob deleted after storing reads as gone", () => {
    const dir = rec();
    const hash = putBlob(dir, bytes("here for now"));
    expect(hasBlob(dir, hash)).toBe(true);
    rmSync(blobPath(dir, hash));
    expect(hasBlob(dir, hash)).toBe(false);
    expect(getBlob(dir, hash)).toBeNull();
  });
});

describe("writing is atomic and private", () => {
  test("no partial file is left behind", () => {
    const dir = rec();
    putBlob(dir, bytes("complete"));
    expect(readdirSync(join(dir, "files")).every((f) => !f.endsWith(".part"))).toBe(true);
  });

  test("a blob is readable only by its owner", () => {
    // The record's own files are 0o600. A blob beside them is no more public.
    const dir = rec();
    const hash = putBlob(dir, bytes("private"));
    expect(statSync(blobPath(dir, hash)).mode & 0o077).toBe(0);
  });

  test("a stray part file is not mistaken for a blob", () => {
    const dir = rec();
    const hash = putBlob(dir, bytes("real"));
    writeFileSync(join(dir, "files", `${hash}.999.part`), "junk");
    expect(new TextDecoder().decode(getBlob(dir, hash) as Uint8Array)).toBe("real");
  });
});

describe("storing through the record, blob and entry together", () => {
  const open = (dir: string) =>
    openConversation(dir, {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => true,
      onRecord: () => {},
      onEffect: () => {},
    });

  const record = (): string => {
    const root = mkdtempSync(join(tmpdir(), "lucid-attach-"));
    createConversationRecord(root, "c");
    return join(root, "c");
  };

  test("a stored attachment leaves a blob and an entry", () => {
    const dir = record();
    const host = open(dir);
    const r = host.writeAttachment({
      bytes: bytes("a log file"),
      contentType: "text/plain",
      name: "run.log",
      text: true,
    });
    host.close();
    expect(r.verdict).toBe("accepted");
    const hash = (r as { hash: string }).hash;
    expect(hasBlob(dir, hash)).toBe(true);
    const log = readFileSync(join(dir, "log.ndjson"), "utf8");
    expect(log).toContain('"src":"attach"');
    expect(log).toContain(hash);
    // The bytes are named, never carried.
    expect(log).not.toContain("a log file");
  });

  test("the record still opens afterwards, and the entry is validated", () => {
    const dir = record();
    const h1 = open(dir);
    h1.writeAttachment({
      bytes: bytes("x"),
      contentType: "text/plain",
      name: "x.txt",
      text: true,
    });
    h1.close();
    const h2 = open(dir);
    expect(h2.state()).toBeDefined();
    h2.close();
  });

  test("a file over the bound is refused and nothing is appended", () => {
    const dir = record();
    const host = open(dir);
    const before = readFileSync(join(dir, "log.ndjson"), "utf8").length;
    const r = host.writeAttachment({
      bytes: new Uint8Array(ATTACHMENT_BYTES_MAX + 1),
      contentType: "image/png",
      name: "huge.png",
      text: false,
    });
    host.close();
    expect(r.verdict).toBe("refused");
    expect(readFileSync(join(dir, "log.ndjson"), "utf8").length).toBe(before);
    expect(existsSync(join(dir, "files"))).toBe(false);
  });

  test("a malformed attach entry stops the record opening", () => {
    // Unlike a title, which is an opinion about a document. An attach entry
    // is the only thing that says a blob exists and what it is.
    const dir = record();
    appendFileSync(
      join(dir, "log.ndjson"),
      `${JSON.stringify({ v: 1, at: 2, src: "attach", hash: "nope", bytes: 1, contentType: "text/plain", name: "x", text: true })}\n`,
    );
    expect(() => open(dir).close()).toThrow();
  });

  test("the same file attached twice is one blob and two entries", () => {
    const dir = record();
    const host = open(dir);
    const a = host.writeAttachment({
      bytes: bytes("same"),
      contentType: "text/plain",
      name: "one.txt",
      text: true,
    });
    const b = host.writeAttachment({
      bytes: bytes("same"),
      contentType: "text/plain",
      name: "two.txt",
      text: true,
    });
    host.close();
    expect((a as { hash: string }).hash).toBe((b as { hash: string }).hash);
    expect(readdirSync(join(dir, "files")).length).toBe(1);
    const lines = readFileSync(join(dir, "log.ndjson"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"src":"attach"'));
    expect(lines.length).toBe(2);
  });
});

test("invalid attachment metadata leaves no blob or log entry", () => {
  const root = rec();
  createConversationRecord(root, "invalid");
  const dir = join(root, "invalid");
  const host = openConversation(dir, {
    now: () => 1234,
    presence: () => undefined,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  const raw = bytes("must not become an orphan");
  try {
    expect(
      host.writeAttachment({ bytes: raw, contentType: "", name: "valid.txt", text: true }),
    ).toEqual({ verdict: "refused", issue: "attachment-invalid" });
    expect(hasBlob(dir, hashBlob(raw))).toBe(false);
    expect(readFileSync(join(dir, "log.ndjson"), "utf8")).toBe("");
  } finally {
    host.close();
  }
});
