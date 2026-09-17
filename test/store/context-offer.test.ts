import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/dispatch.js";
import { readProcessOwner } from "../../src/process-owner.js";
import { encodeAnnotationBatch } from "../../src/protocol/annotations.js";
import { putBlob } from "../../src/store/blobs.js";
import {
  closeNativeContextOffers,
  nativeContextReadIssue,
  offerContext,
  offerProjectedContext,
  readContextProgress,
  readOfferedContext,
} from "../../src/store/context-offer.js";
import { projectConversationContext } from "../../src/store/conversation-context.js";

test("transferred notes offer only referenced files and preserve distinct files with the same name", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-context-files-"));
  const first = Buffer.from("first image");
  const second = Buffer.from("second image");
  const refs = [first, second].map((bytes) => ({
    bytes: bytes.length,
    contentType: "image/png",
    hash: putBlob(record, bytes),
    name: "shot.png",
  }));
  putBlob(record, Buffer.from("unreferenced upload"));
  const original = encodeAnnotationBatch({
    artifactId: "review",
    version: 1,
    notes: refs.map((file) => ({ note: `See ${file.hash}`, spots: [], files: [file] })),
  });
  const context = projectConversationContext({
    artifacts: [],
    from: 0,
    through: 3,
    pendingInputId: "next",
    transcript: {
      aborted: [],
      events: [],
      inputs: [
        { id: "notes", seq: 1, mode: "queue", status: "applied", text: original },
        {
          id: "next",
          seq: 2,
          mode: "queue",
          status: "outstanding",
          text: "Continue from those notes",
        },
      ],
    },
  });
  const offered = offerProjectedContext(record, context);
  try {
    const text = readOfferedContext(offered.path, 0, 65536).text;
    expect(text).toBe(offered.text);
    expect(text.endsWith(context.pending.text)).toBe(true);
    expect(text).not.toContain(record);
    expect(text).not.toContain("unreferenced upload");
    expect(offered.attachments.map((file) => file.entryId)).toEqual(["input:notes", "input:notes"]);
    const paths = offered.attachments.map((file) => file.path);
    for (const path of paths) expect(text).toContain(path ?? "unavailable");
    expect(text).toContain("Use these locations instead of recorded historical paths");
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.every((path) => path?.startsWith(`${offered.path}/`))).toBe(true);
    expect(paths.map((path) => readFileSync(path ?? "").toString())).toEqual([
      "first image",
      "second image",
    ]);
    expect(paths.every((path) => (lstatSync(path ?? "").mode & 0o077) === 0)).toBe(true);
    expect(context.history[0]?.text).toBe(original);
  } finally {
    offered.close();
    expect(existsSync(offered.path)).toBe(false);
    rmSync(record, { force: true, recursive: true });
  }
});

test("the context copy explicitly identifies a referenced blob that is no longer available", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-context-missing-"));
  const text = encodeAnnotationBatch({
    artifactId: "review",
    version: 1,
    notes: [
      {
        note: "Inspect the missing image",
        spots: [],
        files: [
          {
            hash: "f".repeat(64),
            bytes: 5,
            contentType: "image/png",
            name: "missing.png",
            path: "/old/expired/copy.png",
          },
        ],
      },
    ],
  });
  const context = projectConversationContext({
    artifacts: [],
    from: 0,
    through: 2,
    pendingInputId: "next",
    transcript: {
      aborted: [],
      events: [],
      inputs: [{ id: "next", seq: 1, mode: "queue", status: "outstanding", text }],
    },
  });
  const offered = offerProjectedContext(record, context);
  try {
    const restored = readOfferedContext(offered.path, 0, 65536).text;
    const references = restored.split("The current accepted user request follows:")[0] ?? "";
    const manifest: unknown = JSON.parse(references.trim().split("\n\n").at(-1) ?? "null");
    expect(manifest).toEqual([
      {
        entryId: "input:next",
        hash: "f".repeat(64),
        noteIndex: 0,
        path: null,
      },
    ]);
    expect(restored).toContain("A null path means the file is unavailable; say so");
  } finally {
    offered.close();
    rmSync(record, { force: true, recursive: true });
  }
});

test("offered context is private, outside the record, and readable in bounded slices", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-context-record-"));
  const offered = offerContext(record, "quoted content".repeat(10_000));
  try {
    expect(offered.path.startsWith(`${record}/`)).toBe(false);
    expect(lstatSync(offered.path).mode & 0o777).toBe(0o700);
    const first = readOfferedContext(offered.path, 0, 1024);
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(1024);
    expect(first.nextOffset).toBe(1024);
    expect(first.done).toBe(false);
    expect(() => readOfferedContext(offered.path, 0, 1_000_000)).toThrow();
    const target = join(record, "secret");
    writeFileSync(target, "credential fixture");
    rmSync(join(offered.path, "context.txt"));
    symlinkSync(target, join(offered.path, "context.txt"));
    expect(() => readOfferedContext(offered.path, 0, 1024)).toThrow();
  } finally {
    offered.close();
    rmSync(record, { recursive: true, force: true });
  }
});

test("context CLI reads its offered copy without opening the record or using HTTP", async () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-context-cli-"));
  const offered = offerContext(record, "quoted context");
  const output: string[] = [];
  try {
    await runCli(["context", offered.path, "--offset", "0", "--bytes", "1024", "--json"], {
      conversationsFactory: () => {
        throw new Error("must not open records");
      },
      onOutput: (line) => output.push(line),
    });
    expect(JSON.parse(output[0] ?? "{}")).toEqual({
      done: true,
      nextOffset: 14,
      text: "quoted context",
    });
  } finally {
    offered.close();
    rmSync(record, { force: true, recursive: true });
  }
});

test("retrieval rejects traversal and symlink directories and makes UTF-8 progress", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-context-utf8-"));
  const offered = offerContext(record, "🙂🙂🙂");
  const link = join(record, "lucid-context-offer-link");
  try {
    symlinkSync(offered.path, link);
    expect(() => readOfferedContext(link, 0, 5)).toThrow();
    expect(() =>
      readOfferedContext(`${offered.path}/../${offered.path.split("/").at(-1)}`, 0, 5),
    ).toThrow();
    const first = readOfferedContext(offered.path, 0, 5);
    expect(first).toEqual({ done: false, nextOffset: 4, text: "🙂" });
    expect(readOfferedContext(offered.path, 8, 5)).toEqual({
      done: true,
      nextOffset: 12,
      text: "🙂",
    });
    expect(() => readOfferedContext(offered.path, 9, 5)).toThrow();
  } finally {
    offered.close();
    rmSync(record, { force: true, recursive: true });
  }
});

test("slice concatenation preserves byte order marks in recorded content", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-context-bom-"));
  const content = "\uFEFFab\uFEFFcd";
  const offered = offerContext(record, content);
  try {
    let offset = 0;
    let restored = "";
    while (true) {
      const slice = readOfferedContext(offered.path, offset, 5);
      restored += slice.text;
      offset = slice.nextOffset;
      if (slice.done) break;
    }
    expect(restored).toBe(content);
  } finally {
    offered.close();
    rmSync(record, { force: true, recursive: true });
  }
});

test("orphaned context copies are removed after process loss while a live copy survives", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-context-loss-"));
  const live = offerContext(record, "live copy");
  const script = join(record, "child.ts");
  writeFileSync(
    script,
    `import { offerContext } from ${JSON.stringify(new URL("../../src/store/context-offer.ts", import.meta.url).pathname)};\nconst offer = offerContext(${JSON.stringify(record)}, "orphaned test copy");\nprocess.stdout.write(offer.path + "\\n", () => process.kill(process.pid, "SIGKILL"));\n`,
  );
  let orphan = "";
  try {
    const child = Bun.spawnSync([process.execPath, script]);
    orphan = child.stdout.toString().trim();
    expect(orphan).toContain("lucid-context-offer-");
    expect(existsSync(orphan)).toBe(true);
    const next = offerContext(record, "next preparation");
    next.close();
    expect(existsSync(orphan)).toBe(false);
    expect(readOfferedContext(live.path, 0, 64).text).toBe("live copy");
  } finally {
    live.close();
    if (orphan) rmSync(orphan, { recursive: true, force: true });
    rmSync(record, { recursive: true, force: true });
  }
});

test("a context copy survives its preparing helper when the receiving process is still alive", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-native-context-owner-"));
  const script = join(record, "prepare.ts");
  const contextModule = new URL("../../src/store/context-offer.ts", import.meta.url).pathname;
  const ownerModule = new URL("../../src/process-owner.ts", import.meta.url).pathname;
  writeFileSync(
    script,
    [
      `import { offerContext } from ${JSON.stringify(contextModule)};`,
      `import { readProcessOwner } from ${JSON.stringify(ownerModule)};`,
      `const owner = readProcessOwner(${process.pid});`,
      'if (!owner) throw new Error("Missing receiving process");',
      `const copy = offerContext(${JSON.stringify(record)}, "complete feedback survives", { owner });`,
      "process.stdout.write(copy.path);",
    ].join("\n"),
  );
  let path = "";
  try {
    const helper = Bun.spawnSync([process.execPath, script]);
    expect(helper.exitCode).toBe(0);
    path = helper.stdout.toString();
    expect(existsSync(path)).toBe(true);
    const next = offerContext(record, "another preparation triggers cleanup");
    next.close();
    expect(existsSync(path)).toBe(true);
    expect(readOfferedContext(path, 0, 64).text).toBe("complete feedback survives");
  } finally {
    if (path) rmSync(path, { force: true, recursive: true });
    rmSync(record, { force: true, recursive: true });
  }
});

// Confirm cleanup is scoped to both durable offer identity and the exact receiving process.
test("settling one native offer preserves another offer and a different process generation", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-copy-scope-"));
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Missing receiving process");
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const first = offerContext(record, "first", { offerId: firstId, owner });
  const second = offerContext(record, "second", { offerId: secondId, owner });
  try {
    closeNativeContextOffers(owner, firstId);
    expect(existsSync(first.path)).toBe(false);
    expect(readOfferedContext(second.path, 0, 64).text).toBe("second");
    closeNativeContextOffers({ ...owner, startedAt: "another-generation" }, secondId);
    expect(existsSync(second.path)).toBe(true);
    closeNativeContextOffers(owner, secondId);
    expect(existsSync(second.path)).toBe(false);
  } finally {
    first.close();
    second.close();
    rmSync(record, { force: true, recursive: true });
  }
});

test("in-order reads record contiguous progress and doubtful progress counts as unread", () => {
  const record = mkdtempSync(join(tmpdir(), "lucid-context-progress-"));
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("current process owner is unavailable");
  const offerId = crypto.randomUUID();
  const offered = offerContext(record, "0123456789", { offerId, owner });
  try {
    expect(nativeContextReadIssue(owner, offerId, 10)).toEqual({
      kind: "context-unread",
      nextOffset: 0,
    });
    // A read beyond the contiguous prefix is served but does not count.
    expect(readOfferedContext(offered.path, 6, 4).text).toBe("6789");
    expect(readContextProgress(offered.path)).toBe(0);
    readOfferedContext(offered.path, 0, 4);
    readOfferedContext(offered.path, 0, 4);
    expect(readContextProgress(offered.path)).toBe(4);
    readOfferedContext(offered.path, 4, 4);
    expect(nativeContextReadIssue(owner, offerId, 10)).toEqual({
      kind: "context-unread",
      nextOffset: 8,
    });
    readOfferedContext(offered.path, 8, 4);
    expect(nativeContextReadIssue(owner, offerId, 10)).toBeUndefined();
    expect(nativeContextReadIssue(owner, offerId, 11)).toEqual({ kind: "context-missing" });
    const context = join(offered.path, "context.txt");
    const original = readFileSync(context);
    writeFileSync(
      context,
      Buffer.concat([Buffer.from("LUCID_CONTEXT_V0\n"), original.subarray(17)]),
    );
    expect(nativeContextReadIssue(owner, offerId, 10)).toEqual({ kind: "context-missing" });
    writeFileSync(context, original);
    expect(nativeContextReadIssue(owner, crypto.randomUUID(), 10)).toEqual({
      kind: "context-missing",
    });

    const progress = join(offered.path, "progress.json");
    chmodSync(progress, 0o644);
    expect(readContextProgress(offered.path)).toBe(0);
    rmSync(progress);
    writeFileSync(progress, "not json", { mode: 0o600 });
    expect(readContextProgress(offered.path)).toBe(0);
    rmSync(progress);
    const elsewhere = join(record, "forged.json");
    writeFileSync(elsewhere, JSON.stringify({ contiguous: 10 }), { mode: 0o600 });
    symlinkSync(elsewhere, progress);
    expect(readContextProgress(offered.path)).toBe(0);
    expect(nativeContextReadIssue(owner, offerId, 10)).toEqual({
      kind: "context-unread",
      nextOffset: 0,
    });
  } finally {
    offered.close();
    rmSync(record, { force: true, recursive: true });
  }
});
