/**
 * Where a saved version sits in the conversation.
 *
 * A version a person saved is a moment in the thread. It was shown after
 * every message instead, so a save from yesterday appeared below an answer
 * from a minute ago and read as something that had just happened. Seeing it
 * arrive "again" after every new message is what made it unreadable.
 *
 * An artifact entry carries no `seq`, because the fold does not reduce one
 * into state. But the log is one ordered file, so the seq of the last frame
 * accepted before the entry IS its place, and the fold already walks past it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationHost, viewArtifactCatalog } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

const ART = "doc";

const rig = () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-place-"));
  createConversationRecord(root, "c");
  const dir = join(root, "c");
  const host = createConversationHost(dir, {
    now: () => Date.now(),
    presence: () => undefined,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  return {
    dir,
    host,
    write: (version: number, author: string) =>
      host.writeArtifact({
        artifactId: ART,
        version,
        author,
        contentType: "text/html",
        bytes: `<p>v${version}</p>`,
        ...(version > 1 ? { basedOn: version - 1 } : {}),
      }),
    say: (text: string) => host.enqueueInput({ id: `in-${text}`, text, mode: "queue" }),
    seqNow: () => host.transcript().inputs.at(-1)?.seq ?? 0,
    done: () => {
      host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

describe("a version knows where it belongs", () => {
  test("the catalog reports a place for every version", () => {
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("first");
      r.write(2, "human");
      r.say("second");
      r.write(3, "agent");

      const [entry] = viewArtifactCatalog(r.dir);
      expect(entry?.afterSeq?.[1]).toBeDefined();
      expect(entry?.afterSeq?.[2]).toBeDefined();
      expect(entry?.afterSeq?.[3]).toBeDefined();
    } finally {
      r.done();
    }
  });

  test("a version written later has a later place", () => {
    // The property a reader needs: ordering by place matches ordering in the
    // file, so a save from before a message renders before it.
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("one");
      r.write(2, "human");
      r.say("two");
      r.write(3, "human");

      const [entry] = viewArtifactCatalog(r.dir);
      const at = entry?.afterSeq ?? {};
      expect(at[1]).toBeLessThan(at[2] as number);
      expect(at[2]).toBeLessThan(at[3] as number);
    } finally {
      r.done();
    }
  });

  test("a version's place is the last line before it, not after it", () => {
    const r = rig();
    try {
      r.say("before");
      const seqBefore = r.seqNow();
      r.write(1, "human");
      r.say("after");

      const [entry] = viewArtifactCatalog(r.dir);
      // It follows the line that preceded it. Anything larger would place it
      // after a line it genuinely came before.
      expect(entry?.afterSeq?.[1]).toBe(seqBefore);
    } finally {
      r.done();
    }
  });

  test("a version written before anything was said sits at the start", () => {
    const r = rig();
    try {
      r.write(1, "human");
      r.say("afterwards");
      const [entry] = viewArtifactCatalog(r.dir);
      expect(entry?.afterSeq?.[1]).toBe(0);
    } finally {
      r.done();
    }
  });

  test("the place survives reopening the record", () => {
    // It is derived by folding, not stored, so a second fold has to agree
    // with the first or the marker moves between page loads.
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("one");
      r.write(2, "human");
      const first = viewArtifactCatalog(r.dir)[0]?.afterSeq;
      const second = viewArtifactCatalog(r.dir)[0]?.afterSeq;
      expect(second).toEqual(first);
    } finally {
      r.done();
    }
  });
});
