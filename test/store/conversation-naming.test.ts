import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecordMetadata } from "../../src/store/record-identity.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function record() {
  const root = mkdtempSync(join(tmpdir(), "lucid-naming-"));
  roots.push(root);
  const { paths } = createConversationRecord(root, "c");
  return paths;
}
function open(dir: string) {
  return openConversation(dir, {
    now: () => 1000,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
}

test("submission persists the original prompt title and eligibility, but opening is read only", () => {
  const paths = record();
  // An older accepted input is evidence from before naming existed.
  writeFileSync(
    paths.logPath,
    `${JSON.stringify({ v: 1, at: 900, src: "input", input: { id: "original", text: "Fix the project search results before adding filters", mode: "queue" } })}\n`,
  );
  const before = readFileSync(paths.metaPath, "utf8");
  const host = open(paths.dir);
  expect(readFileSync(paths.metaPath, "utf8")).toBe(before);
  expect(host.enqueueInput({ id: "later", text: "A different topic", mode: "queue" }).verdict).toBe(
    "accepted",
  );
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Fix the project search results before adding",
    titleOrigin: "fallback",
    titleRevision: 1,
    titleGeneration: {
      v: 1,
      inputId: "original",
      source: "Fix the project search results before adding filters",
      attempts: 0,
      status: "eligible",
      basedOn: 1,
    },
  });
  host.close();
});

test("naming consumes durable attempts and repairs invalid output only once across reopen", async () => {
  const { claimNaming, finishNaming } = await import("../../src/store/conversation-naming.js");
  const paths = record();
  open(paths.dir).enqueueInput({ id: "first", text: "Repair the search page", mode: "queue" });
  const first = claimNaming(paths.dir, "c");
  expect(first).toMatchObject({ attempts: 1, status: "running" });
  expect(readRecordMetadata(paths.dir).titleGeneration).toMatchObject({ attempts: 1 });
  if (!first) throw new Error("Expected naming claim");
  finishNaming(paths.dir, "c", first, {
    kind: "result",
    text: "one two three four five six seven eight",
  });
  const repair = claimNaming(paths.dir, "c");
  expect(repair).toMatchObject({ attempts: 2, status: "running" });
  if (!repair) throw new Error("Expected repair claim");
  finishNaming(paths.dir, "c", repair, { kind: "result", text: "!!!" });
  expect(claimNaming(paths.dir, "c")).toBeNull();
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Repair the search page",
    titleGeneration: { attempts: 2, status: "failed" },
  });
  const interrupted = record();
  open(interrupted.dir).enqueueInput({ id: "first", text: "Interrupted naming", mode: "queue" });
  expect(claimNaming(interrupted.dir, "c")).not.toBeNull();
  // A successor owns the job lock. A consumed launch has no confirmed result.
  expect(claimNaming(interrupted.dir, "c")).toBeNull();
  expect(readRecordMetadata(interrupted.dir).titleGeneration).toMatchObject({
    attempts: 1,
    status: "failed",
    reason: "interrupted",
  });
});

test("manual rename rejects stale revisions and defeats a late generated result", async () => {
  const { claimNaming, finishNaming, renameConversation } = await import(
    "../../src/store/conversation-naming.js"
  );
  const paths = record();
  open(paths.dir).enqueueInput({ id: "a", text: "Find search issues", mode: "queue" });
  const claim = claimNaming(paths.dir, "c");
  if (!claim) throw new Error("Expected naming claim");
  expect(() =>
    renameConversation(paths.dir, "c", 1, "one two three four five six seven eight"),
  ).toThrow("seven words");
  expect(renameConversation(paths.dir, "c", 1, "  Search   repairs ")).toMatchObject({
    title: "Search repairs",
    titleRevision: 2,
    titleOrigin: "manual",
  });
  expect(() => renameConversation(paths.dir, "c", 1, "Stale name")).toThrow("changed");
  finishNaming(paths.dir, "c", claim, { kind: "result", text: "Generated search title" });
  open(paths.dir).enqueueInput({ id: "b", text: "Unrelated later task", mode: "queue" });
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Search repairs",
    titleRevision: 2,
    titleOrigin: "manual",
  });
  expect(claimNaming(paths.dir, "c")).toBeNull();
});

test("a durable submission recovers naming after metadata loss without migrating untouched legacy records", async () => {
  const { recoverConversationNaming } = await import("../../src/store/log.js");
  const paths = record();
  open(paths.dir).enqueueInput({ id: "a", text: "Keep this original prompt", mode: "queue" });
  // Simulate death after input fsync, before the derived metadata replacement.
  writeFileSync(paths.metaPath, JSON.stringify({ v: 1, conversationId: "c" }));
  await recoverConversationNaming(paths.dir, "c");
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Keep this original prompt",
    titleGeneration: { inputId: "a", attempts: 0, status: "eligible" },
  });
  const legacy = record();
  writeFileSync(
    legacy.logPath,
    `${JSON.stringify({ v: 1, at: 1, src: "input", input: { id: "old", text: "Legacy prompt", mode: "queue" } })}\n`,
  );
  const before = readFileSync(legacy.metaPath, "utf8");
  recoverConversationNaming(legacy.dir, "c");
  expect(readFileSync(legacy.metaPath, "utf8")).toBe(before);
});

test("attachment-only input has a short label and waits for the first text without reading file contents", async () => {
  const { encodeAnnotationBatch } = await import("../../src/protocol/annotations.js");
  const { readConversationTitle } = await import("../../src/store/conversation-label.js");
  const paths = record();
  const host = open(paths.dir);
  const text = encodeAnnotationBatch({
    artifactId: "doc",
    version: 1,
    notes: [
      {
        note: "",
        spots: [],
        files: [
          { hash: "a".repeat(64), bytes: 12, contentType: "text/plain", name: "private.txt" },
        ],
      },
    ],
  });
  host.enqueueInput({ id: "file", text, mode: "queue" });
  expect(await readConversationTitle(paths.dir)).toBe("Attachment conversation");
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Attachment conversation",
    titleGeneration: { status: "waiting-input", attempts: 0 },
  });
  host.enqueueInput({ id: "text", text: "Explain the design", mode: "queue" });
  expect(await readConversationTitle(paths.dir)).toBe("Explain the design");
  expect(readRecordMetadata(paths.dir)).toMatchObject({
    conversationTitle: "Explain the design",
    titleGeneration: {
      inputId: "text",
      source: "Explain the design",
      status: "eligible",
      attempts: 0,
    },
  });
});

test("explicit rename repairs a legacy title whose invalid revision projects as zero", async () => {
  const { renameConversation } = await import("../../src/store/conversation-naming.js");
  const paths = record();
  writeFileSync(
    paths.metaPath,
    JSON.stringify({
      v: 1,
      conversationId: "c",
      conversationTitle: "Legacy title",
      titleRevision: -1,
    }),
  );
  expect(renameConversation(paths.dir, "c", 0, "Recovered title")).toMatchObject({
    title: "Recovered title",
    titleRevision: 1,
    titleOrigin: "manual",
  });
});
