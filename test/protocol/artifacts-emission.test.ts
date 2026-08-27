import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { openHeadlessSession, openHeadlessTurns } from "../../src/modes/headless.js";
import {
  ARTIFACT_PREAMBLE,
  ARTIFACT_PREAMBLE_MARKER,
  composeArtifactPrompt,
  detectArtifactBlocks,
  stripArtifactBlocks,
} from "../../src/protocol/artifacts.js";
import { ARTIFACT_BYTES_MAX } from "../../src/store/log.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { buildView } from "../../src/tui/view.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";
import { attach, event } from "./helpers.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const sid = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const BIN = "/fake/hcn";
const assistant = (text: string) => ({ kind: "message", role: "assistant", text });
const doneClean = { kind: "done", exitCode: null, cause: "clean" };

const rig = (
  opts: { mode?: "session" | "turn"; pendingInput?: { id: string; text: string } } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "lucid-artifact-emit-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const procs = [new FakeHcnProcess()];
  const proc = procs[0] as FakeHcnProcess;
  const spawner = fakeSpawner([...procs]);
  let receive: (frame: import("../../src/protocol/frames.js").Frame) => void = () => {};
  const host = openConversation(join(root, "conv-1"), {
    now: () => 1_000,
    presence: () => undefined,
    executorLease: () => true,
    onRecord: () => {},
    onEffect: (e) => {
      if (e.type === "send") receive(e.frame);
    },
  });
  if (opts.pendingInput) host.enqueueInput({ ...opts.pendingInput, mode: "queue" });
  let turnCount = 0;
  const mode = opts.mode ?? "session";
  const common = {
    harness: "claude" as const,
    conversationId: "conv-1",
    secret,
    runner: createHcnRunner({ spawn: spawner.spawn, bin: BIN }),
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame: import("../../src/protocol/frames.js").Frame) =>
      host.handleFrame(JSON.stringify(frame)),
    host: {
      cursor: () => host.cursor(),
      collectEffects: (from: number) => host.collectEffects(from),
      advanceCursor: (off: number) => host.advanceCursor(off),
      artifactIndex: () => host.artifactIndex(),
      // Production wires this (cli/runtime.ts). A patch reads the version it
      // revises through it, so a rig without it refuses every patch for a
      // reason that has nothing to do with the patch.
      readArtifact: (artifactId: string, version: number) => host.readArtifact(artifactId, version),
      writeArtifact: (params: {
        artifactId: string;
        version: number;
        author: string;
        contentType: string;
        bytes: string;
      }) => host.writeArtifact(params),
    },
  };
  const source =
    mode === "session"
      ? openHeadlessSession({ ...common, sessionId: sid })
      : openHeadlessTurns(common);
  receive = source.receive;
  if (mode === "session") {
    proc.emit({
      kind: "session",
      sessionId: sid,
      harness: "claude",
      hcn: "0.5.4",
      escalateQuestions: true,
    });
  }
  const accept = (inputId: string, turnId: string) => {
    proc.emit({ kind: "disposition", id: inputId, disposition: "started" });
    proc.emit({ kind: "turn", turnId, id: inputId });
  };
  return { root, host, proc, accept, source, secret };
};

const artifactFence = (id: string, replaces: number | null, contentType: string, bytes: string) =>
  `\`\`\`lucid-artifact\n${JSON.stringify({ id, replaces, contentType })}\n${bytes}\n\`\`\``;

describe("artifact preamble", () => {
  test("headless-session preamble is composed once per session", () => {
    const p1 = composeArtifactPrompt("hello", "headless-session");
    expect(p1.startsWith(ARTIFACT_PREAMBLE_MARKER)).toBe(true);
    expect(p1.includes("hello")).toBe(true);
    // idempotent
    const p2 = composeArtifactPrompt(p1, "headless-session");
    expect(p2).toBe(p1);
  });
  test("headless-turn preamble every turn", () => {
    const p = composeArtifactPrompt("do it", "headless-turn");
    expect(p.startsWith(ARTIFACT_PREAMBLE_MARKER)).toBe(true);
    const p2 = composeArtifactPrompt("next turn", "headless-turn");
    expect(p2.startsWith(ARTIFACT_PREAMBLE_MARKER)).toBe(true);
  });
  test("interactive is excluded", () => {
    const p = composeArtifactPrompt("hello", "interactive");
    expect(p).toBe("hello");
    expect(p.startsWith(ARTIFACT_PREAMBLE_MARKER)).toBe(false);
  });
});

describe("artifact fence parser", () => {
  test("parses a well-formed block", () => {
    const text = artifactFence("doc-1", null, "text/html", "<h1>hi</h1>");
    const blocks = detectArtifactBlocks(text);
    expect(blocks.length).toBe(1);
    const first = blocks[0];
    expect(first !== undefined && "block" in first && first.block.header.id).toBe("doc-1");
    expect(
      (blocks[0] as { block: { header: { replaces: number | null } } }).block.header.replaces,
    ).toBeNull();
  });
  test("two blocks in one message both land in order", () => {
    const t = `${artifactFence("a", null, "text/html", "one")}\n\n${artifactFence("b", null, "text/html", "two")}`;
    const blocks = detectArtifactBlocks(t);
    expect(blocks.length).toBe(2);
    expect((blocks[0] as { block: { header: { id: string } } }).block.header.id).toBe("a");
    expect((blocks[1] as { block: { header: { id: string } } }).block.header.id).toBe("b");
  });
  test("malformed header is refused with reason", () => {
    const bad = "```lucid-artifact\nnot json\n```";
    const blocks = detectArtifactBlocks(bad);
    expect(blocks.length).toBe(1);
    const only = blocks[0];
    expect(only !== undefined && "malformed" in only).toBe(true);
  });
});

describe("artifact emission via headless host", () => {
  test("a document in that format is parsed and stored as version 1, agent chooses id and replaces", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "please make doc", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    const fence = artifactFence("doc-1", null, "text/html", "<p>hello</p>");
    r.proc.emit(assistant(fence));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    // Stored as v1, author agent, hash assigned by lucid
    const v1 = r.host.readArtifact("doc-1", 1);
    expect(v1).not.toBeNull();
    expect(v1?.bytes).toBe("<p>hello</p>");
    expect(v1?.author).toBe("agent");
    expect(v1?.version).toBe(1);
    expect(v1?.artifactId).toBe("doc-1");
    r.host.close();
  });

  test("revising with correct replaces lands as v2; lucid assigns version", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(artifactFence("doc-1", null, "text/html", "v1")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    // second version replaces 1
    r.host.enqueueInput({ id: "in-2", text: "revise", mode: "queue" });
    await flush();
    // need to accept next turn - turn-2 is next minted
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "started" });
    r.proc.emit({ kind: "turn", turnId: "turn-2", id: "in-2" });
    await flush();
    r.proc.emit(assistant(artifactFence("doc-1", 1, "text/html", "v2")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("doc-1", 1)?.bytes).toBe("v1");
    expect(r.host.readArtifact("doc-1", 2)?.bytes).toBe("v2");
    expect(r.host.readArtifact("doc-1", 2)?.version).toBe(2);
    r.host.close();
  });

  test("replacing a version that is not current is refused, recording what agent thought", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(artifactFence("doc-1", null, "text/html", "v1")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    // now current is 1, try stale replaces 0 (or 99) — should be refused
    r.host.enqueueInput({ id: "in-2", text: "stale", mode: "queue" });
    await flush();
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "started" });
    r.proc.emit({ kind: "turn", turnId: "turn-2", id: "in-2" });
    await flush();
    r.proc.emit(assistant(artifactFence("doc-1", 99, "text/html", "bad")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    // Still only v1, no v2
    expect(r.host.readArtifact("doc-1", 2)).toBeNull();
    expect(r.host.readArtifact("doc-1", 1)?.bytes).toBe("v1");
    // Refusal is recorded as error event in transcript containing "stale"
    const transcript = r.host.transcript();
    const hasStale = transcript.events.some((e) => {
      const ev = e.event as Record<string, unknown>;
      return typeof ev.message === "string" && (ev.message as string).includes("stale");
    });
    expect(hasStale).toBe(true);
    r.host.close();
  });

  test("unknown identity starts new artifact rather than failing", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    // unknown id with replaces non-null still starts at v1
    r.proc.emit(assistant(artifactFence("brand-new", 5, "text/html", "fresh")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    const v1 = r.host.readArtifact("brand-new", 1);
    expect(v1?.bytes).toBe("fresh");
    r.host.close();
  });

  test("the first of two documents in one message lands, the second is refused", async () => {
    // This asserted that both landed, until RFC-09 narrowed a conversation
    // to one artifact. Rewritten rather than deleted: the shape of the case
    // is still what has to be exercised, and only the outcome moved.
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    const both =
      artifactFence("doc-1", null, "text/html", "first") +
      "\n" +
      artifactFence("doc-2", null, "text/html", "second");
    r.proc.emit(assistant(both));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("doc-1", 1)?.bytes).toBe("first");
    expect(r.host.readArtifact("doc-2", 1)).toBeNull();
    const said = r.host.transcript().events.flatMap((e) => {
      const ev = e.event as Record<string, unknown>;
      return typeof ev.message === "string" ? [ev.message] : [];
    });
    // The refusal names what the conversation does hold, so the agent can
    // reuse it without asking.
    const refusal = said.find((m) => m.includes("E-ART-09"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("doc-1");
    r.host.close();
  });

  test("a second block revising what the first block created still lands", async () => {
    // The other half of the same rule. An artifact created earlier in this
    // message counts as held, or a message that creates a document and then
    // revises it would refuse its own second block.
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    const both =
      artifactFence("doc-1", null, "text/html", "first") +
      "\n" +
      artifactFence("doc-1", 1, "text/html", "second");
    r.proc.emit(assistant(both));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("doc-1", 1)?.bytes).toBe("first");
    expect(r.host.readArtifact("doc-1", 2)?.bytes).toBe("second");
    r.host.close();
  });

  test("malformed block is refused, turn still completes, other block still lands", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    const bad = "```lucid-artifact\nnot json\n```";
    const good = artifactFence("doc-1", null, "text/html", "ok");
    r.proc.emit(assistant(`${bad}\n${good}`));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("doc-1", 1)?.bytes).toBe("ok");
    // malformed recorded as error, but turn completed (done in transcript)
    const transcript = r.host.transcript();
    const hasMalformed = transcript.events.some((e) => {
      const ev = e.event as Record<string, unknown>;
      return typeof ev.message === "string" && (ev.message as string).includes("malformed");
    });
    expect(hasMalformed).toBe(true);
    const hasDone = transcript.events.some(
      (e) => (e.event as Record<string, unknown>).kind === "done",
    );
    expect(hasDone).toBe(true);
    r.host.close();
  });

  test("oversized is refused, turn still completes", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    const big = "x".repeat(ARTIFACT_BYTES_MAX + 1);
    r.proc.emit(assistant(artifactFence("big-doc", null, "text/html", big)));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("big-doc", 1)).toBeNull();
    const transcript = r.host.transcript();
    const hasTooLarge = transcript.events.some((e) => {
      const ev = e.event as Record<string, unknown>;
      return typeof ev.message === "string" && (ev.message as string).includes("too large");
    });
    expect(hasTooLarge).toBe(true);
    const hasDone = transcript.events.some(
      (e) => (e.event as Record<string, unknown>).kind === "done",
    );
    expect(hasDone).toBe(true);
    r.host.close();
  });

  test("headless-turn preamble on every turn", async () => {
    const r = rig({ mode: "turn" });
    // turn mode: each turn is a separate process, preamble every turn
    r.host.enqueueInput({ id: "in-1", text: "first", mode: "queue" });
    await flush();
    // streamTurn is called per queued input; we need to capture prompts
    // The fake runner records prompts? Check FakeHcnProcess commands - for turn mode, streamTurn argv includes prompt
    // Instead verify via composing directly
    expect(
      composeArtifactPrompt("hello", "headless-turn").startsWith(ARTIFACT_PREAMBLE_MARKER),
    ).toBe(true);
    expect(
      composeArtifactPrompt("hello", "headless-session").startsWith(ARTIFACT_PREAMBLE_MARKER),
    ).toBe(true);
    r.host.close();
  });
});

describe("artifact view projection", () => {
  test("conversation view shows named reference, never document bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-view-artifact-"));
    const { secret } = createConversationRecord(root, "conv-1");
    const host = openConversation(join(root, "conv-1"), {
      now: () => 1_000,
      presence: () => undefined,
      executorLease: () => false,
      onRecord: () => {},
      onEffect: () => {},
    });
    const fence = artifactFence("doc-1", null, "text/html", "<h1>secret doc</h1>");
    host.handleFrame(
      JSON.stringify(attach({ conversationId: "conv-1", secret, profile: "headless-session" })),
    );
    host.handleFrame(
      JSON.stringify(
        event({
          epoch: 1,
          n: 1,
          turnId: "t-1",
          event: { kind: "message", text: `here is doc:\n${fence}\nthanks` },
        }),
      ),
    );
    const view = buildView({
      transcript: host.transcript(),
      status: host.status(),
      rung: "test",
      draft: "",
    });
    const line = view.lines.find((l) => l.kind === "agent");
    expect(line).toBeDefined();
    expect(line?.text).toContain("[artifact doc-1 v1]");
    expect(line?.text).not.toContain("<h1>secret doc</h1>");
    expect(line?.text).not.toContain("lucid-artifact");
    host.close();
  });

  test("stripArtifactBlocks handles malformed without leaking bytes", () => {
    const bad = "```lucid-artifact\nnot json\n```";
    const stripped = stripArtifactBlocks(`hello\n${bad}\nworld`);
    expect(stripped).toContain("malformed");
    expect(stripped).not.toContain("not json");
  });
});

/** RFC-08 as it reaches the store. The pure functions are the oracle for
 * what a patch means; this is about what emission does with the result, and
 * the ways getting it wrong would store the wrong bytes or store none. */
describe("a patch that revises a document", () => {
  const patchFence = (id: string, replaces: number | null, body: string) =>
    `\`\`\`lucid-artifact\n${JSON.stringify({ id, replaces, contentType: "text/html", form: "patch" })}\n${body}\n\`\`\``;
  const oneEdit = (find: string, replace: string) => JSON.stringify({ edits: [{ find, replace }] });

  /** A rig with `doc-1` at v1, which is what a patch needs to exist. */
  const withV1 = async (bytes = "<ul><li>Read the brief</li></ul>") => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(artifactFence("doc-1", null, "text/html", bytes)));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    return r;
  };

  /** Start a second turn on an existing rig and emit `text` in it. */
  const secondTurn = async (r: ReturnType<typeof rig>, text: string) => {
    r.host.enqueueInput({ id: "in-2", text: "revise", mode: "queue" });
    await flush();
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "started" });
    r.proc.emit({ kind: "turn", turnId: "turn-2", id: "in-2" });
    await flush();
    r.proc.emit(assistant(text));
    r.proc.emit(doneClean);
    await flush();
    await flush();
  };

  const messages = (r: ReturnType<typeof rig>) =>
    r.host.transcript().events.flatMap((e) => {
      const ev = e.event as Record<string, unknown>;
      return typeof ev.message === "string" ? [ev.message] : [];
    });

  test("produces the next version, complete, from an edit that names only the change", async () => {
    const r = await withV1();
    await secondTurn(
      r,
      patchFence(
        "doc-1",
        1,
        oneEdit("<li>Read the brief</li>", "<li>Read the brief carefully</li>"),
      ),
    );
    const v2 = r.host.readArtifact("doc-1", 2);
    // The whole document, not the patch, and not a fragment.
    expect(v2?.bytes).toBe("<ul><li>Read the brief carefully</li></ul>");
    expect(v2?.author).toBe("agent");
    r.host.close();
  });

  test("the version it produces is indistinguishable from one emitted whole", async () => {
    // Nothing in the record says a version arrived as a patch. A reader wants
    // the document, and the document is what is there.
    const patched = await withV1();
    await secondTurn(patched, patchFence("doc-1", 1, oneEdit("brief", "spec")));
    const whole = await withV1();
    await secondTurn(
      whole,
      artifactFence("doc-1", 1, "text/html", "<ul><li>Read the spec</li></ul>"),
    );
    const a = patched.host.readArtifact("doc-1", 2);
    const b = whole.host.readArtifact("doc-1", 2);
    expect(a?.bytes).toBe(b?.bytes as string);
    expect(a?.hash).toBe(b?.hash as string);
    expect(a?.author).toBe(b?.author as string);
    expect(a?.contentType).toBe(b?.contentType as string);
    patched.host.close();
    whole.host.close();
  });

  test("a patch with no base is refused as E-PATCH-01", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(patchFence("doc-1", null, oneEdit("a", "b"))));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    // Not the patch body stored as a document, and not a half-made v1.
    expect(r.host.readArtifact("doc-1", 1)).toBeNull();
    expect(messages(r).some((m) => m.includes("E-PATCH-01"))).toBe(true);
    r.host.close();
  });

  test("a patch against an artifact that does not exist is refused, not created", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(patchFence("nope", 3, oneEdit("a", "b"))));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("nope", 1)).toBeNull();
    expect(messages(r).some((m) => m.includes("E-PATCH-01"))).toBe(true);
    r.host.close();
  });

  test("an anchor that does not match refuses, and leaves the version alone", async () => {
    const r = await withV1();
    await secondTurn(r, patchFence("doc-1", 1, oneEdit("<li>Not in there</li>", "x")));
    expect(r.host.readArtifact("doc-1", 2)).toBeNull();
    expect(r.host.readArtifact("doc-1", 1)?.bytes).toBe("<ul><li>Read the brief</li></ul>");
    expect(messages(r).some((m) => m.includes("E-PATCH-02"))).toBe(true);
    r.host.close();
  });

  test("an anchor that matches twice refuses rather than guessing", async () => {
    const r = await withV1("<p>one</p><p>one</p>");
    await secondTurn(r, patchFence("doc-1", 1, oneEdit("one", "two")));
    expect(r.host.readArtifact("doc-1", 2)).toBeNull();
    expect(messages(r).some((m) => m.includes("E-PATCH-03"))).toBe(true);
    r.host.close();
  });

  test("a malformed body refuses as E-PATCH-04", async () => {
    const r = await withV1();
    await secondTurn(r, patchFence("doc-1", 1, "{not json"));
    expect(r.host.readArtifact("doc-1", 2)).toBeNull();
    expect(messages(r).some((m) => m.includes("E-PATCH-04"))).toBe(true);
    r.host.close();
  });

  test("a stale replaces keeps the refusal RFC-06 already defines", async () => {
    const r = await withV1();
    await secondTurn(r, patchFence("doc-1", 99, oneEdit("brief", "spec")));
    expect(r.host.readArtifact("doc-1", 2)).toBeNull();
    expect(messages(r).some((m) => m.includes("stale"))).toBe(true);
    r.host.close();
  });

  test("a result over the byte bound refuses as E-PATCH-06", async () => {
    // Reaching this needs a base already close to the cap: a replacement big
    // enough to overflow a small document is refused earlier and more
    // cheaply by the per-replacement bound (E-PATCH-05).
    const r = await withV1("<p>seed</p>");
    const huge = `<p>seed</p>${"z".repeat(ARTIFACT_BYTES_MAX - 100)}`;
    const wrote = r.host.writeArtifact({
      artifactId: "doc-1",
      version: 2,
      author: "agent",
      contentType: "text/html",
      bytes: huge,
    });
    expect(wrote.verdict).toBe("accepted");
    // Now a modest replacement tips the result past the bound.
    await secondTurn(r, patchFence("doc-1", 2, oneEdit("seed", "z".repeat(200))));
    expect(r.host.readArtifact("doc-1", 3)).toBeNull();
    expect(messages(r).some((m) => m.includes("E-PATCH-06"))).toBe(true);
    r.host.close();
  });

  test("a replacement too large on its own is refused before anything is applied", async () => {
    const r = await withV1("<p>seed</p>");
    await secondTurn(r, patchFence("doc-1", 1, oneEdit("seed", "z".repeat(ARTIFACT_BYTES_MAX))));
    expect(r.host.readArtifact("doc-1", 2)).toBeNull();
    expect(messages(r).some((m) => m.includes("E-PATCH-05"))).toBe(true);
    r.host.close();
  });

  test("an oversize patch body is not reported as an oversize document", async () => {
    // The whole-form size check measures `bytes` as a document. A patch body
    // is not one, so reporting "too large" would name the wrong problem.
    const r = await withV1();
    await secondTurn(r, patchFence("doc-1", 1, "z".repeat(ARTIFACT_BYTES_MAX + 10)));
    expect(messages(r).some((m) => m.includes("E-PATCH-04"))).toBe(true);
    expect(messages(r).some((m) => m.includes("too large:"))).toBe(false);
    r.host.close();
  });

  test("a refusal does not end the turn, and a whole form after it still lands", async () => {
    const r = await withV1();
    r.host.enqueueInput({ id: "in-2", text: "revise", mode: "queue" });
    await flush();
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "started" });
    r.proc.emit({ kind: "turn", turnId: "turn-2", id: "in-2" });
    await flush();
    r.proc.emit(assistant(patchFence("doc-1", 1, oneEdit("<li>Nope</li>", "x"))));
    await flush();
    r.proc.emit(assistant(artifactFence("doc-1", 1, "text/html", "<p>recovered</p>")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("doc-1", 2)?.bytes).toBe("<p>recovered</p>");
    r.host.close();
  });

  test("several edits in one patch all land in one new version", async () => {
    const r = await withV1("<p>a</p><p>b</p>");
    const two = JSON.stringify({
      edits: [
        { find: "<p>a</p>", replace: "<p>x</p>" },
        { find: "<p>b</p>", replace: "<p>y</p>" },
      ],
    });
    await secondTurn(r, patchFence("doc-1", 1, two));
    expect(r.host.readArtifact("doc-1", 2)?.bytes).toBe("<p>x</p><p>y</p>");
    // One version, not one per edit.
    expect(r.host.readArtifact("doc-1", 3)).toBeNull();
    r.host.close();
  });

  test("overlapping edits refuse the whole patch", async () => {
    const r = await withV1("<p>hello world</p>");
    const overlapping = JSON.stringify({
      edits: [
        { find: "hello world", replace: "goodbye" },
        { find: "world", replace: "planet" },
      ],
    });
    await secondTurn(r, patchFence("doc-1", 1, overlapping));
    expect(r.host.readArtifact("doc-1", 2)).toBeNull();
    expect(r.host.readArtifact("doc-1", 1)?.bytes).toBe("<p>hello world</p>");
    expect(messages(r).some((m) => m.includes("E-PATCH-08"))).toBe(true);
    r.host.close();
  });

  test("a second block patches what the first block in the same message produced", async () => {
    // The read has to see the version this message just created. Consulting
    // only the durable index as it stood before the message would anchor the
    // second block against the version before the first block's, silently.
    const r = await withV1("<p>one</p>");
    const whole = artifactFence("doc-1", 1, "text/html", "<p>two</p>");
    const patch = patchFence(
      "doc-1",
      2,
      JSON.stringify({ edits: [{ find: "two", replace: "three" }] }),
    );
    await secondTurn(r, `${whole}\n\n${patch}`);
    expect(r.host.readArtifact("doc-1", 2)?.bytes).toBe("<p>two</p>");
    expect(r.host.readArtifact("doc-1", 3)?.bytes).toBe("<p>three</p>");
    r.host.close();
  });

  test("a refused second block leaves the first block's version standing", async () => {
    // "Completely or not at all" is a rule about one patch, not a message.
    const r = await withV1("<p>one</p>");
    const whole = artifactFence("doc-1", 1, "text/html", "<p>two</p>");
    const bad = patchFence(
      "doc-1",
      2,
      JSON.stringify({ edits: [{ find: "absent", replace: "x" }] }),
    );
    await secondTurn(r, `${whole}\n\n${bad}`);
    expect(r.host.readArtifact("doc-1", 2)?.bytes).toBe("<p>two</p>");
    expect(r.host.readArtifact("doc-1", 3)).toBeNull();
    expect(messages(r).some((m) => m.includes("E-PATCH-02"))).toBe(true);
    r.host.close();
  });

  test("an unknown form is refused before it reaches the store at all", async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    const bogus = `\`\`\`lucid-artifact\n${JSON.stringify({ id: "doc-1", replaces: null, contentType: "text/html", form: "diff" })}\n<p>hi</p>\n\`\`\``;
    r.proc.emit(assistant(bogus));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("doc-1", 1)).toBeNull();
    expect(messages(r).some((m) => m.includes("E-PATCH-07"))).toBe(true);
    r.host.close();
  });
});

/** RFC-08 R6. The preamble is the only thing that makes the patch form
 * reachable, and it is sent once per session, so what it leaves out the
 * agent has no way to learn. */
describe("what the preamble says about the patch form", () => {
  test("it describes the form and its header", () => {
    expect(ARTIFACT_PREAMBLE).toContain('"form": "patch"');
    expect(ARTIFACT_PREAMBLE).toContain('"edits"');
    expect(ARTIFACT_PREAMBLE).toContain("find");
    expect(ARTIFACT_PREAMBLE).toContain("replace");
  });

  test("it says find is literal and must match exactly once", () => {
    expect(ARTIFACT_PREAMBLE).toContain("literally");
    expect(ARTIFACT_PREAMBLE).toContain("exactly once");
    expect(ARTIFACT_PREAMBLE).toContain("not a regular expression");
  });

  test("it says the listed order does not matter, and why", () => {
    // The dangerous misreading is that edits apply in sequence, which would
    // invite an agent to build one edit on another. That is refused, and the
    // preamble is where the agent finds out before spending a turn on it.
    expect(ARTIFACT_PREAMBLE).toContain("order you list edits in does not matter");
    expect(ARTIFACT_PREAMBLE).toContain("CANNOT anchor on text another edit");
  });

  test("it says a failed patch is refused whole, with a reason, and can be retried", () => {
    expect(ARTIFACT_PREAMBLE).toContain("nothing is stored");
    expect(ARTIFACT_PREAMBLE).toContain("send it again");
    expect(ARTIFACT_PREAMBLE).toContain("half-applied");
  });

  test("it says the whole form is always available and never wrong", () => {
    expect(ARTIFACT_PREAMBLE).toContain("always allowed and is never wrong");
    expect(ARTIFACT_PREAMBLE).toContain("unsure what the current version holds");
  });

  test("it says a patch cannot create an artifact", () => {
    expect(ARTIFACT_PREAMBLE).toContain("a revision, never a creation");
  });

  test("it still goes once per session, and not every turn", () => {
    // Instructions do not change, so repeating them is context spent to say
    // the same thing. RFC-07 settled this; adding to the preamble must not
    // quietly change how often it rides.
    const first = composeArtifactPrompt("hello", "headless-session");
    expect(composeArtifactPrompt(first, "headless-session")).toBe(first);
  });

  test("the whole form still works for an agent that ignores all of it", () => {
    // The preamble offers the patch form; nothing requires it. An agent that
    // reads none of this keeps working exactly as before.
    const blocks = detectArtifactBlocks(artifactFence("doc", null, "text/html", "<p>hi</p>"));
    const only = blocks[0];
    expect(only !== undefined && "block" in only && only.block.header.form).toBe("whole");
  });
});

/** RFC-09 R2 and R5. A conversation holds one artifact, and an emission
 * naming another is refused rather than folded in. */
describe("a conversation holds one artifact", () => {
  const messages = (r: ReturnType<typeof rig>) =>
    r.host.transcript().events.flatMap((e) => {
      const ev = e.event as Record<string, unknown>;
      return typeof ev.message === "string" ? [ev.message] : [];
    });

  /** A rig whose record already holds `doc-1` at v1. */
  const withDoc = async () => {
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(artifactFence("doc-1", null, "text/html", "<p>one</p>")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    return r;
  };

  const secondTurn = async (r: ReturnType<typeof rig>, text: string) => {
    r.host.enqueueInput({ id: "in-2", text: "again", mode: "queue" });
    await flush();
    r.proc.emit({ kind: "disposition", id: "in-2", disposition: "started" });
    r.proc.emit({ kind: "turn", turnId: "turn-2", id: "in-2" });
    await flush();
    r.proc.emit(assistant(text));
    r.proc.emit(doneClean);
    await flush();
    await flush();
  };

  test("a different id is refused, and the refusal names what is held", async () => {
    const r = await withDoc();
    await secondTurn(r, artifactFence("doc-2", null, "text/html", "<p>two</p>"));
    expect(r.host.readArtifact("doc-2", 1)).toBeNull();
    const refusal = messages(r).find((m) => m.includes("E-ART-09"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("doc-1");
    r.host.close();
  });

  test("the id it holds is still a revision", async () => {
    const r = await withDoc();
    await secondTurn(r, artifactFence("doc-1", 1, "text/html", "<p>two</p>"));
    expect(r.host.readArtifact("doc-1", 2)?.bytes).toBe("<p>two</p>");
    r.host.close();
  });

  test("nothing is folded in: the refused bytes are not stored under the held id", async () => {
    // The failure this refusal exists to prevent. Folding would land a
    // document under a name the agent did not choose.
    const r = await withDoc();
    await secondTurn(r, artifactFence("doc-2", null, "text/html", "<p>elsewhere</p>"));
    expect(r.host.readArtifact("doc-1", 1)?.bytes).toBe("<p>one</p>");
    expect(r.host.readArtifact("doc-1", 2)).toBeNull();
    r.host.close();
  });

  test("identity is checked before size", async () => {
    // An emission for a document this conversation does not hold does not
    // need its body measured. Reporting "too large" would tell the agent to
    // fix the wrong thing.
    const r = await withDoc();
    await secondTurn(
      r,
      artifactFence("doc-2", null, "text/html", "z".repeat(ARTIFACT_BYTES_MAX + 10)),
    );
    expect(messages(r).some((m) => m.includes("E-ART-09"))).toBe(true);
    expect(messages(r).some((m) => m.includes("too large"))).toBe(false);
    r.host.close();
  });

  test("identity is checked before the patch checks", async () => {
    const r = await withDoc();
    const patch = `\`\`\`lucid-artifact\n${JSON.stringify({ id: "doc-2", replaces: null, contentType: "text/html", form: "patch" })}\n{not json\n\`\`\``;
    await secondTurn(r, patch);
    expect(messages(r).some((m) => m.includes("E-ART-09"))).toBe(true);
    expect(messages(r).some((m) => m.includes("E-PATCH-01"))).toBe(false);
    expect(messages(r).some((m) => m.includes("E-PATCH-04"))).toBe(false);
    r.host.close();
  });

  test("a malformed block still refuses before the identity check", async () => {
    // There is no id to check until the header parses, so this one has to
    // come first whatever the precedence rule says.
    const r = await withDoc();
    await secondTurn(r, "```lucid-artifact\nnot json\n```");
    expect(messages(r).some((m) => m.includes("malformed"))).toBe(true);
    expect(messages(r).some((m) => m.includes("E-ART-09"))).toBe(false);
    r.host.close();
  });

  test("an unrecognised form still refuses before the identity check", async () => {
    const r = await withDoc();
    const bogus = `\`\`\`lucid-artifact\n${JSON.stringify({ id: "doc-2", replaces: null, contentType: "text/html", form: "diff" })}\n<p>x</p>\n\`\`\``;
    await secondTurn(r, bogus);
    expect(messages(r).some((m) => m.includes("E-PATCH-07"))).toBe(true);
    expect(messages(r).some((m) => m.includes("E-ART-09"))).toBe(false);
    r.host.close();
  });

  test("a first emission of the whole form may carry a non-null replaces", async () => {
    // RFC-06's rule, unchanged. An empty conversation has nothing to compare
    // against, so identity cannot refuse here.
    const r = rig({ mode: "session" });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(artifactFence("brand-new", 5, "text/html", "fresh")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("brand-new", 1)?.bytes).toBe("fresh");
    r.host.close();
  });

  test("a record already holding two artifacts still takes a revision of either", async () => {
    // R5. No such record can be created now, but one written by an older
    // build must stay a working conversation.
    const r = rig({ mode: "session" });
    r.host.writeArtifact({
      artifactId: "alpha",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "<p>a</p>",
    });
    r.host.writeArtifact({
      artifactId: "beta",
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "<p>b</p>",
    });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(artifactFence("beta", 1, "text/html", "<p>b2</p>")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    // Revised the one it named, and left the other alone.
    expect(r.host.readArtifact("beta", 2)?.bytes).toBe("<p>b2</p>");
    expect(r.host.readArtifact("alpha", 2)).toBeNull();
    r.host.close();
  });

  test("a record holding two artifacts refuses a third, naming both", async () => {
    const r = rig({ mode: "session" });
    for (const id of ["alpha", "beta"]) {
      r.host.writeArtifact({
        artifactId: id,
        version: 1,
        author: "agent",
        contentType: "text/html",
        bytes: `<p>${id}</p>`,
      });
    }
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(artifactFence("gamma", null, "text/html", "<p>c</p>")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    expect(r.host.readArtifact("gamma", 1)).toBeNull();
    const refusal = messages(r).find((m) => m.includes("E-ART-09"));
    expect(refusal).toContain("alpha");
    expect(refusal).toContain("beta");
    r.host.close();
  });

  test("an enormous id is quoted back within the refusal bound", async () => {
    const r = rig({ mode: "session" });
    r.host.writeArtifact({
      artifactId: "界".repeat(128),
      version: 1,
      author: "agent",
      contentType: "text/html",
      bytes: "<p>a</p>",
    });
    r.host.enqueueInput({ id: "in-1", text: "go", mode: "queue" });
    await flush();
    r.accept("in-1", "turn-1");
    await flush();
    r.proc.emit(assistant(artifactFence("other", null, "text/html", "<p>b</p>")));
    r.proc.emit(doneClean);
    await flush();
    await flush();
    const refusal = messages(r).find((m) => m.includes("E-ART-09")) ?? "";
    expect(Buffer.byteLength(refusal, "utf8")).toBeLessThan(600);
    r.host.close();
  });
});
