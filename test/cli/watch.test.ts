import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchConversation } from "../../src/cli/watch.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import type { TuiView } from "../../src/tui/view.js";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "lucid-watch-"));

const until = async (cond: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("watch condition not met before deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A second writer: `lucid send` growing the record the viewer watches. */
const writer = (root: string, conversationId: string) =>
  openConversation(join(root, conversationId), {
    now: () => 1_000,
    presence: () => undefined,
    // A second writer never holds the lease: it appends and leaves the
    // effects for whoever is driving, exactly as `lucid send` does.
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });

const humanText = (view: TuiView): readonly string[] =>
  view.lines.filter((l) => l.kind === "human").map((l) => l.text);

// The viewer is the regression test for the tailer extraction (RFC-04
// step 4): the loop now lives in store:followRecord, and these prove the
// viewer's observable behaviour did not move with it.
describe("lucid watch over the shared tailer (RFC-04 step 4 regression)", () => {
  test("paints the first view immediately, then follows a record another process grows", async () => {
    const root = freshRoot();
    createConversationRecord(root, "conv-1");
    const host = writer(root, "conv-1");
    host.enqueueInput({ id: "in-1", text: "hello", mode: "queue" });

    const controller = new AbortController();
    const views: TuiView[] = [];
    const watching = watchConversation("conv-1", {
      rootDir: root,
      pollMs: 10,
      signal: controller.signal,
      onView: (v) => views.push(v),
    });
    expect(views.length).toBe(1); // first paint is synchronous
    expect(humanText(views[0] as TuiView)).toEqual(["hello"]);

    host.enqueueInput({ id: "in-2", text: "second", mode: "queue" });
    await until(() => views.slice(1).some((v) => humanText(v).includes("second")));

    controller.abort();
    await watching;
  });

  test("a missing record paints a watch-error view, and the poll picks the record up once it exists", async () => {
    const root = freshRoot();
    const controller = new AbortController();
    const views: TuiView[] = [];
    const watching = watchConversation("conv-late", {
      rootDir: root,
      pollMs: 10,
      signal: controller.signal,
      onView: (v) => views.push(v),
    });
    expect(views[0]?.status).toBe("error");
    expect(views[0]?.lines[0]?.text).toMatch(/^watch error: /);

    createConversationRecord(root, "conv-late");
    const host = writer(root, "conv-late");
    host.enqueueInput({ id: "in-1", text: "late", mode: "queue" });
    await until(() => views.some((v) => humanText(v).includes("late")));

    controller.abort();
    await watching;
  });
});
