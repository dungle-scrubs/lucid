/**
 * What a running session is told, input by input.
 *
 * A session driver opens one harness session and sends every input down it.
 * Three things ride on an input, and they do not have the same lifetime:
 *
 * - The artifact protocol preamble is instructions. It does not change, so
 *   it is said once.
 * - The artifact state is what the record holds right now. It changes under
 *   the session — a person saving a version is exactly that.
 * - The annotation preamble belongs to the batch of notes in the input
 *   carrying it, so it goes with every batch.
 *
 * All three were behind the once-per-session flag. From the second input
 * onward the agent was told nothing about a save, and would name a stale
 * version in its next revision for a reason neither side could see. That is
 * the failure these hold shut, and no test saw it: every prompt test until
 * now sent one input.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { HCN_MIN_VERSION } from "../../src/harness/version.js";
import { createHeadlessHost, hostSeamFor } from "../../src/modes/host.js";
import { encodeAnnotationBatch } from "../../src/protocol/annotations.js";
import type { Frame } from "../../src/protocol/frames.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";

const SID = "eb04301d-8756-4a8b-ae3e-aac0e71f7265";
const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

const rig = () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-session-prompt-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const host = openConversation(join(root, "conv-1"), {
    now: () => Date.now(),
    presence: () => undefined,
    executorLease: () => true,
    onRecord: () => {},
    onEffect: () => {},
  });
  let turns = 0;
  const source = createHeadlessHost(
    {
      harness: "claude",
      conversationId: "conv-1",
      secret,
      runner: createHcnRunner({ spawn: spawner.spawn, bin: "/fake/hcn" }),
      mintTurnId: () => `turn-${++turns}`,
      sendFrame: (f: Frame) => host.handleFrame(JSON.stringify(f)),
      sessionId: SID,
      host: hostSeamFor(host),
    } as unknown as Parameters<typeof createHeadlessHost>[0],
    "headless-session",
  );
  proc.emit({
    kind: "session",
    sessionId: SID,
    harness: "claude",
    hcn: HCN_MIN_VERSION,
    escalateQuestions: true,
  });
  let seq = 0;
  return {
    host,
    /** Every prompt the driver has handed the harness, in order. */
    sent: (): string[] =>
      proc.commands
        .filter((m) => m.op === "send" && typeof m.text === "string")
        .map((m) => m.text as string),
    say: (text: string) => {
      seq += 1;
      source.receive({ kind: "input", seq, id: `in-${seq}`, text, mode: "queue" });
    },
    /** What the harness says back, so a refusal can be provoked. The turn has
     * to be opened first: an assistant message outside one is not routed. */
    emitAssistant: (text: string) => {
      proc.emit({ kind: "disposition", id: `in-${seq}`, disposition: "started" });
      proc.emit({ kind: "turn", turnId: `turn-${seq}`, id: `in-${seq}` });
      proc.emit({ kind: "message", role: "assistant", text });
      proc.emit({ kind: "done", exitCode: null, cause: "clean" });
    },
    write: (version: number, author: string, values?: Record<string, string>) =>
      host.writeArtifact({
        artifactId: "doc",
        version,
        author,
        contentType: "text/html",
        bytes: `<p>v${version}</p>`,
        ...(version > 1 ? { basedOn: version - 1 } : {}),
        ...(values === undefined ? {} : { values }),
      }),
    done: () => {
      source.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};

describe("a save reaches the agent on the next thing it is told", () => {
  test("a version written after the first input is named on the second", async () => {
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("first");
      await settle();

      // What the browser does on Save: a new version, authored by the
      // person, based on the one they were looking at.
      r.write(2, "human", { e5: "Kevin" });
      r.say("second");
      await settle();

      const sent = r.sent();
      expect(sent.length).toBe(2);
      expect(sent[0]).toContain("doc — current version 1");
      const second = sent[1] ?? "";
      expect(second).toContain("doc — current version 2, saved by the person");
      expect(second).toContain("working from version 1");
      // The half of a save the document cannot express on its own.
      expect(second).toContain('{"e5":"Kevin"}');
    } finally {
      r.done();
    }
  });

  test("every later input carries the state too, not just the one after a save", async () => {
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("one");
      await settle();
      r.write(2, "human", { e5: "Kevin" });
      r.say("two");
      await settle();
      r.say("three");
      await settle();

      const sent = r.sent();
      expect(sent.length).toBe(3);
      for (const text of sent.slice(1)) {
        expect(text).toContain("current version 2");
      }
    } finally {
      r.done();
    }
  });

  test("the protocol instructions are said once, not every time", async () => {
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("one");
      await settle();
      r.say("two");
      await settle();

      const sent = r.sent();
      // Instructions do not change, and repeating them on every input would
      // be the cost this flag exists to avoid.
      expect(sent[0]).toContain("[lucid artifact protocol]");
      expect(sent[1]).not.toContain("[lucid artifact protocol]");
      for (const prompt of sent) {
        expect(prompt).toContain("only create or modify the Lucid artifact");
        expect(prompt).toContain("Do not change project files or implement code changes.");
        expect(prompt).toContain("not to work requested separately in the terminal");
      }
      // The state is not instructions, and goes with both.
      expect(sent[1]).toContain("[lucid artifact state]");
    } finally {
      r.done();
    }
  });

  test("a batch of notes sent later still says what a batch of notes is", async () => {
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("just talking");
      await settle();

      r.say(
        encodeAnnotationBatch({
          artifactId: "doc",
          version: 1,
          notes: [
            { note: "explain this", spots: [{ id: "e3", snippet: "a line", author: "agent" }] },
          ],
        }),
      );
      await settle();

      const sent = r.sent();
      // It rode on the same once-only flag, so a batch was explained only if
      // it happened to be the first thing said in the session.
      expect(sent[1]).toContain("lucid-annotations");
      expect(sent[1]).toContain("[lucid annotation protocol]");
    } finally {
      r.done();
    }
  });

  test("with no artifacts, later inputs still carry request guidance without artifact state", async () => {
    const r = rig();
    try {
      r.say("hello");
      await settle();
      r.say("again");
      await settle();

      const sent = r.sent();
      expect(sent[0]).not.toContain("[lucid artifact state]");
      expect(sent[1]).not.toContain("[lucid artifact state]");
      expect(sent[1]).toContain("only create or modify the Lucid artifact");
      expect(sent[1]?.endsWith("\n\nagain")).toBe(true);
    } finally {
      r.done();
    }
  });
});

/**
 * RFC-08 E-PATCH-02 recovery.
 *
 * The state block carries bytes only for a version a person saved, because
 * the agent has the ones it wrote. A failed anchor is where that reasoning
 * breaks: the agent's picture of its own version has drifted, which is WHY
 * the anchor missed, and its own current version is then the one thing it is
 * never sent. Without this the retry is another guess from the same picture.
 */
describe("a patch that missed gets the document back", () => {
  /** Emit an assistant message carrying a patch whose anchor is absent. */
  const missingAnchor = (id: string, replaces: number) =>
    `\`\`\`lucid-artifact\n${JSON.stringify({ id, replaces, contentType: "text/html", form: "patch" })}\n${JSON.stringify({ edits: [{ find: "text that is not in the document", replace: "x" }] })}\n\`\`\``;

  test("its own current version rides on the next prompt, and not before", async () => {
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("first");
      await settle();
      // Before any miss, the agent is not sent what it already wrote.
      expect(r.sent()[0]).not.toContain("<p>v1</p>");

      r.emitAssistant(missingAnchor("doc", 1));
      await settle();

      r.say("second");
      await settle();
      const second = r.sent()[1] as string;
      expect(second).toContain("<p>v1</p>");
      expect(second).toContain("your patch did not match");
    } finally {
      r.done();
    }
  });

  test("it is sent once, not on every prompt after", async () => {
    // The whole point of RFC-08 is keeping the document out of the context.
    // A debt that never clears would put it back on every turn.
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("first");
      await settle();
      r.emitAssistant(missingAnchor("doc", 1));
      await settle();
      r.say("second");
      await settle();
      r.say("third");
      await settle();
      expect(r.sent()[1]).toContain("<p>v1</p>");
      expect(r.sent()[2]).not.toContain("<p>v1</p>");
    } finally {
      r.done();
    }
  });

  test("a refusal that is not a missed anchor does not resend anything", async () => {
    // The other refusals say what is wrong with the patch itself, and the
    // agent can act on the reason alone. Resending for those would spend
    // context on a problem the reason already solved.
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("first");
      await settle();
      const malformed = `\`\`\`lucid-artifact\n${JSON.stringify({ id: "doc", replaces: 1, contentType: "text/html", form: "patch" })}\n{not json\n\`\`\``;
      r.emitAssistant(malformed);
      await settle();
      r.say("second");
      await settle();
      expect(r.sent()[1]).not.toContain("<p>v1</p>");
    } finally {
      r.done();
    }
  });

  test("a person's save is still sent whether or not anything missed", async () => {
    const r = rig();
    try {
      r.write(1, "agent");
      r.say("first");
      await settle();
      r.write(2, "human");
      r.say("second");
      await settle();
      expect(r.sent()[1]).toContain("<p>v2</p>");
      expect(r.sent()[1]).toContain("what they saved");
    } finally {
      r.done();
    }
  });
});
