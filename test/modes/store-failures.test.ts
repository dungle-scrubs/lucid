import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";

const SYNTHETIC_HCN_IDENTITY = "synthetic";

import { createHeadlessHost, hostSeamFor, type SourceEnd } from "../../src/modes/host.js";
import type { Frame } from "../../src/protocol/frames.js";
import { openWriter } from "../../src/store/conversation-host.js";
import { StoreError } from "../../src/store/errors.js";
import { LockError } from "../../src/store/flock.js";
import { createConversationRecord } from "../../src/store/store.js";
import { FakeHcnProcess, fakeArtifactHost, fakeSpawner } from "../harness/fakes.js";

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const rig = (
  failure: (operation: "read" | "write") => void,
  reporting: "accept" | "refuse" | "throw" = "accept",
  profile: "headless-session" | "headless-turn" = "headless-session",
) => {
  const root = mkdtempSync(join(tmpdir(), "lucid-read-failed-"));
  const { secret } = createConversationRecord(root, "conv");
  const host = openWriter(join(root, "conv"));
  host.writeArtifact({
    artifactId: "doc",
    version: 1,
    author: "agent",
    bytes: "<p>one</p>",
    contentType: "text/html",
  });
  const proc = new FakeHcnProcess();
  const ends: SourceEnd[] = [];
  const frames: Frame[] = [];
  const source = createHeadlessHost(
    {
      harness: "claude",
      conversationId: "conv",
      secret,
      runner: createHcnRunner({ spawn: fakeSpawner([proc]).spawn, bin: "/fake/hcn" }),
      mintTurnId: () => "turn-1",
      sessionId: "session-1",
      host: fakeArtifactHost({
        ...hostSeamFor(host),
        writeArtifact: (params) => {
          failure("write");
          return host.writeArtifact(params);
        },
        readArtifact: (id, version) => {
          failure("read");
          return host.readArtifact(id, version);
        },
      }),
      onEnded: (end) => ends.push(end),
      sendFrame: (frame) => {
        frames.push(frame);
        if (frame.kind === "event" && frame.event.kind === "error") {
          if (reporting === "refuse") return { verdict: "refused", issue: "too-large" };
          if (reporting === "throw") throw new StoreError("append-failed", "synthetic failure");
        }
        return host.handleFrame(JSON.stringify(frame));
      },
    },
    profile,
  );
  if (profile === "headless-session")
    proc.emit({
      kind: "session",
      sessionId: "session-1",
      harness: "claude",
      hcn: SYNTHETIC_HCN_IDENTITY,
    });
  return { host, proc, source, ends, frames };
};

test.each(["headless-session", "headless-turn"] as const)(
  "an unreadable artifact stops %s without appending another event",
  async (profile) => {
    const r = rig(
      () => {
        throw new StoreError("corrupt-log", "synthetic corruption");
      },
      "accept",
      profile,
    );
    const before = r.frames.length;
    r.source.receive({ kind: "input", id: "in-1", text: "continue", mode: "queue", seq: 1 });
    await settle();
    expect(r.ends).toEqual([
      {
        kind: "store-failed",
        code: "record-unreadable",
        operation: "artifact-state",
        artifactId: "doc",
      },
    ]);
    expect(r.frames.slice(before).filter((f) => f.kind !== "disposition")).toEqual([]);
    if (profile === "headless-session")
      expect(r.proc.commands.some((c) => c.op === "close")).toBe(true);
    r.source.close();
    r.proc.exit(0);
    r.host.close();
  },
);

test.each([
  ["headless-session", "refuse"],
  ["headless-session", "throw"],
  ["headless-turn", "refuse"],
  ["headless-turn", "throw"],
] as const)(
  "%s: a busy read whose warning fails (%s) stops after one append attempt",
  async (profile, reporting) => {
    const r = rig(
      () => {
        throw new LockError("lock-timeout", "test-lock", "busy");
      },
      reporting,
      profile,
    );
    const before = r.frames.length;
    try {
      r.source.receive({ kind: "input", id: "in-1", text: "continue", mode: "queue", seq: 1 });
      await settle();
      expect(r.frames.slice(before).filter((f) => f.kind !== "disposition").length).toBe(1);
      expect(r.ends).toEqual([
        {
          kind: "store-failed",
          code: "record-busy",
          operation: "artifact-state",
          artifactId: "doc",
        },
      ]);
      r.source.receive({ kind: "input", id: "in-2", text: "later", mode: "queue", seq: 2 });
      r.source.close();
      expect(r.frames.slice(before).filter((f) => f.kind !== "disposition").length).toBe(1);
      expect(r.proc.commands.filter((c) => c.op === "send")).toEqual([]);
    } finally {
      r.source.close();
      r.proc.exit(0);
      r.host.close();
    }
  },
);

test("a successfully recorded busy warning omits state and lets the input continue", async () => {
  const r = rig(() => {
    throw new LockError("lock-timeout", "test-lock", "busy");
  });
  try {
    r.source.receive({ kind: "input", id: "in-1", text: "continue", mode: "queue", seq: 1 });
    await settle();
    expect(r.ends).toEqual([]);
    const send = r.proc.commands.find((c) => c.op === "send");
    expect(send?.text).toContain("is busy");
    expect(send?.text).not.toContain("<p>one</p>");
    expect(
      r.frames.filter((f) => f.kind === "event" && f.event.code === "record-busy"),
    ).toHaveLength(1);
  } finally {
    r.source.close();
    r.proc.exit(0);
    r.host.close();
  }
});

test("a busy state read preserves bytes owed after an anchor refusal", async () => {
  let busy = false;
  const r = rig(() => {
    if (busy) throw new LockError("lock-timeout", "test-lock", "busy");
  });
  const input = (seq: number) =>
    r.source.receive({ kind: "input", id: `in-${seq}`, text: "continue", mode: "queue", seq });
  const sent = () => r.proc.commands.filter((c) => c.op === "send");
  try {
    input(1);
    await settle();
    r.proc.emit({ kind: "disposition", id: "in-1", disposition: "started" });
    r.proc.emit({ kind: "turn", turnId: "native-1", id: "in-1" });
    r.proc.emit({
      kind: "message",
      role: "assistant",
      text: '```lucid-artifact\n{"id":"doc","replaces":1,"contentType":"text/html","form":"patch"}\n{"edits":[{"find":"missing","replace":"two"}]}\n```',
    });
    r.proc.emit({ kind: "done", exitCode: null, cause: "clean" });
    await settle();
    expect(
      r.frames.some(
        (f) =>
          f.kind === "event" &&
          typeof f.event.message === "string" &&
          f.event.message.includes("E-PATCH-02"),
      ),
    ).toBe(true);
    busy = true;
    input(2);
    await settle();
    expect(sent()[1]?.text).toContain("is busy");
    expect(sent()[1]?.text).not.toContain("<p>one</p>");
    busy = false;
    input(3);
    await settle();
    expect(sent()[2]?.text).toContain("<p>one</p>");
    input(4);
    await settle();
    expect(sent()[3]?.text).not.toContain("<p>one</p>");
    expect(r.ends).toEqual([]);
  } finally {
    r.source.close();
    r.proc.exit(0);
    r.host.close();
  }
});

test.each(["headless-session", "headless-turn"] as const)(
  "%s stops when its patch base is unreadable",
  async (profile) => {
    let broken = false;
    const r = rig(
      () => {
        if (broken) throw new StoreError("fold-refused", "synthetic refusal");
      },
      "accept",
      profile,
    );
    try {
      r.source.receive({ kind: "input", id: "in-1", text: "revise", mode: "queue", seq: 1 });
      await settle();
      if (profile === "headless-session") {
        r.proc.emit({ kind: "disposition", id: "in-1", disposition: "started" });
        r.proc.emit({ kind: "turn", turnId: "native-1", id: "in-1" });
      }
      broken = true;
      r.proc.emit({
        kind: "message",
        role: "assistant",
        text: '```lucid-artifact\n{"id":"doc","replaces":1,"contentType":"text/html","form":"patch"}\n{"edits":[{"find":"one","replace":"two"}]}\n```',
      });
      await settle();
      expect(r.ends).toEqual([
        {
          kind: "store-failed",
          code: "record-unreadable",
          operation: "patch-base",
          artifactId: "doc",
        },
      ]);
      expect(r.host.artifactHeads().get("doc")).toBe(1);
      const afterFailure = r.frames.length;
      r.source.close();
      r.proc.emit({ kind: "done", exitCode: null, cause: "clean" });
      r.proc.exit(0);
      await settle();
      expect(r.frames).toHaveLength(afterFailure);
    } finally {
      r.source.close();
      r.proc.exit(0);
      r.host.close();
    }
  },
);

test.each([
  new StoreError("append-failed", "synthetic write failure"),
  new LockError("lock-unavailable", "test-lock", "synthetic unavailable lock"),
])("an artifact write failure keeps its diagnostic classification: %s", async (failure) => {
  const r = rig((operation) => {
    if (operation === "write") throw failure;
  });
  try {
    r.source.receive({ kind: "input", id: "in-1", text: "revise", mode: "queue", seq: 1 });
    await settle();
    r.proc.emit({ kind: "disposition", id: "in-1", disposition: "started" });
    r.proc.emit({ kind: "turn", turnId: "native-1", id: "in-1" });
    r.proc.emit({
      kind: "message",
      role: "assistant",
      text: '```lucid-artifact\n{"id":"doc","replaces":1,"contentType":"text/html"}\n<p>two</p>\n```',
    });
    await settle();
    expect(r.ends).toEqual([
      { kind: "store-failed", code: "record-write-failed", operation: "turn" },
    ]);
    expect(r.host.artifactHeads().get("doc")).toBe(1);
  } finally {
    r.source.close();
    r.proc.exit(0);
    r.host.close();
  }
});
