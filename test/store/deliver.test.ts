/**
 * Getting an attachment to the agent (RFC-11).
 *
 * The assertion that matters most is negative: **no path inside the record
 * ever appears in an input.** `secret` lives in that directory and is the
 * credential that authenticates a driver to the host, so an inside-record path
 * handed to an agent is a credential disclosure rather than a leak of where
 * files are.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobPath, putBlob } from "../../src/store/blobs.js";
import { type AttachmentRef, deliverAttachments } from "../../src/store/deliver.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A record with `secret` in it, and a place to offer files from that is not
 * the record. */
const rig = (): { recordDir: string; offerDir: string } => {
  const root = mkdtempSync(join(tmpdir(), "lucid-deliver-"));
  const recordDir = join(root, "record");
  const offerDir = join(root, "offer", "turn-1");
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(join(recordDir, "secret"), "a".repeat(64));
  return { recordDir, offerDir };
};

const put = (recordDir: string, body: Uint8Array, over: Partial<AttachmentRef> = {}) => {
  const hash = putBlob(recordDir, body);
  return {
    ref: {
      hash,
      contentType: "text/plain",
      name: "note.txt",
      text: true,
      ...over,
    } as AttachmentRef,
    hash,
  };
};

const deliver = (
  r: { recordDir: string; offerDir: string },
  attachments: readonly AttachmentRef[],
  typed = "have a look",
  textMax = 1_000_000,
) => deliverAttachments({ ...r, typed, attachments, textMax });

describe("text goes into the input", () => {
  test("its contents appear", () => {
    const r = rig();
    const { ref } = put(r.recordDir, bytes("line one\nline two"));
    const d = deliver(r, [ref]);
    expect(d.text).toContain("line one");
    expect(d.text).toContain("line two");
    expect(d.outcomes[0]?.kind).toBe("inlined");
  });

  test("what the person typed is kept", () => {
    const r = rig();
    const { ref } = put(r.recordDir, bytes("contents"));
    expect(deliver(r, [ref], "please read this").text.startsWith("please read this")).toBe(true);
  });

  test("nothing is copied out for an inlined file", () => {
    const r = rig();
    const { ref } = put(r.recordDir, bytes("small"));
    deliver(r, [ref]);
    expect(existsSync(r.offerDir)).toBe(false);
  });
});

describe("everything else is named", () => {
  test("an image is named, never inlined", () => {
    const r = rig();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const { ref } = put(r.recordDir, png, {
      contentType: "image/png",
      name: "shot.png",
      text: false,
    });
    const d = deliver(r, [ref]);
    expect(d.outcomes[0]?.kind).toBe("named");
    expect(d.text).toContain("shot.png");
  });

  test("the named copy holds the same bytes", () => {
    const r = rig();
    const png = new Uint8Array([0x89, 0x50, 0x00, 0xff]);
    const { ref } = put(r.recordDir, png, { name: "shot.png", text: false });
    const d = deliver(r, [ref]);
    const at = (d.outcomes[0] as { path: string }).path;
    expect([...new Uint8Array(readFileSync(at))]).toEqual([...png]);
  });

  test("a text file too large to inline is named, not refused", () => {
    // It was accepted when it was stored. Refusing it now would be accepting
    // something and then rejecting it.
    const r = rig();
    const { ref } = put(r.recordDir, bytes("x".repeat(5_000)));
    const d = deliver(r, [ref], "typed", 1_000);
    expect(d.outcomes[0]?.kind).toBe("named");
    expect(d.text).not.toContain("x".repeat(100));
  });

  test("a file claiming to be text but holding binary is named", () => {
    // The entry and the blob are two things, and only one of them is bytes.
    const r = rig();
    const { ref } = put(r.recordDir, new Uint8Array([0x61, 0x00, 0x62]), { text: true });
    expect(deliver(r, [ref]).outcomes[0]?.kind).toBe("named");
  });
});

describe("no path inside the record reaches an agent", () => {
  test("the offered path is outside the record", () => {
    const r = rig();
    const { ref } = put(r.recordDir, new Uint8Array([0x00, 0x01]), { text: false });
    const d = deliver(r, [ref]);
    const at = (d.outcomes[0] as { path: string }).path;
    expect(at.startsWith(r.recordDir)).toBe(false);
    expect(d.text).not.toContain(r.recordDir);
  });

  test("the input never mentions the blob store", () => {
    const r = rig();
    const { ref, hash } = put(r.recordDir, new Uint8Array([0x00]), { text: false });
    const d = deliver(r, [ref]);
    expect(d.text).not.toContain(blobPath(r.recordDir, hash));
    expect(d.text).not.toContain("/files/");
  });

  test("secret is never named, and is not beside the copy", () => {
    const r = rig();
    const { ref } = put(r.recordDir, new Uint8Array([0x00]), { text: false });
    const d = deliver(r, [ref]);
    const at = (d.outcomes[0] as { path: string }).path;
    expect(d.text).not.toContain("secret");
    expect(existsSync(join(at, "..", "secret"))).toBe(false);
  });

  test("a filename that is a path does not become one", () => {
    const r = rig();
    const { ref, hash } = put(r.recordDir, new Uint8Array([0x00]), {
      name: "../../secret",
      text: false,
    });
    const d = deliver(r, [ref]);
    const at = (d.outcomes[0] as { path: string }).path;
    // Falls back to the hash, which is always an ordinary name.
    expect(at).toBe(join(r.offerDir, hash));
  });

  test("the copy is readable only by its owner", () => {
    const r = rig();
    const { ref } = put(r.recordDir, new Uint8Array([0x00]), { text: false });
    const d = deliver(r, [ref]);
    const at = (d.outcomes[0] as { path: string }).path;
    expect(statSync(at).mode & 0o077).toBe(0);
  });
});

describe("a blob that is gone", () => {
  test("is reported and the turn still runs", () => {
    const r = rig();
    const { ref, hash } = put(r.recordDir, bytes("here for now"));
    rmSync(blobPath(r.recordDir, hash));
    const d = deliver(r, [ref], "still talking");
    expect(d.outcomes[0]?.kind).toBe("missing");
    expect(d.text).toContain("still talking");
    expect(d.text).toContain("no longer available");
  });
});

describe("what the input says happened", () => {
  test("a named file is never described as read", () => {
    const r = rig();
    const { ref } = put(r.recordDir, new Uint8Array([0x00]), { text: false });
    const t = deliver(r, [ref]).text.toLowerCase();
    for (const claim of ["i have read", "the agent saw", "you have seen"]) {
      expect(t).not.toContain(claim);
    }
    // It says where, and admits the agent may not manage it.
    expect(t).toContain("if you can");
  });

  test("every attachment gets exactly one outcome, in order", () => {
    const r = rig();
    const a = put(r.recordDir, bytes("first"), { name: "a.txt" });
    const b = put(r.recordDir, new Uint8Array([0x00]), { name: "b.bin", text: false });
    const d = deliver(r, [a.ref, b.ref]);
    expect(d.outcomes.length).toBe(2);
    expect(d.outcomes[0]?.kind).toBe("inlined");
    expect(d.outcomes[1]?.kind).toBe("named");
  });

  test("no attachments leaves the input as typed", () => {
    const r = rig();
    expect(deliver(r, [], "just talking").text).toBe("just talking");
  });
});
