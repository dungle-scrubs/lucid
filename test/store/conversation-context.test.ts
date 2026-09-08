import { expect, test } from "bun:test";
import { projectConversationContext } from "../../src/store/conversation-context.js";

test("context quotes recorded roles and current artifact while keeping the pending request separate", () => {
  const context = projectConversationContext({
    through: 9,
    from: 0,
    pendingInputId: "next",
    transcript: {
      aborted: [],
      inputs: [
        { seq: 1, id: "first", text: "Keep the original API", mode: "queue", status: "applied" },
        { seq: 9, id: "next", text: "Continue the work", mode: "queue", status: "outstanding" },
      ],
      events: [
        {
          seq: 2,
          epoch: 1,
          turnId: "old",
          event: { kind: "message", role: "assistant", text: "The API stays compatible" },
        },
        {
          seq: 3,
          epoch: 1,
          turnId: "old",
          event: { kind: "tool", name: "read", input: "README.md", result: "Existing contract" },
        },
        {
          seq: 4,
          epoch: 1,
          turnId: "old",
          event: { kind: "identity", sessionId: "native", secret: "never-project-me" },
        },
      ],
    },
    artifacts: [
      {
        artifactId: "plan",
        version: 2,
        author: "human",
        contentType: "text/html",
        bytes: "<p>Reviewed revision</p>",
        hash: "a".repeat(64),
        at: 1,
      },
    ],
  });
  expect(context.pending).toMatchObject({ id: "input:next", text: "Continue the work" });
  expect(context.history.map((entry) => entry.id)).toEqual(["input:first", "event:2", "event:3"]);
  expect(context.history[1]).toMatchObject({
    role: "assistant",
    provenance: { epoch: 1, turnId: "old" },
  });
  expect(context.mandatory[0]).toMatchObject({
    id: "artifact:plan:2",
    role: "human",
    text: "<p>Reviewed revision</p>",
  });
  expect(JSON.stringify(context)).not.toContain("never-project-me");
  expect(JSON.stringify(context)).toContain("Existing contract");
});

test("context distinguishes waiting work and recorded fragments from completed messages", () => {
  const context = projectConversationContext({
    artifacts: [],
    from: 0,
    through: 6,
    pendingInputId: "current",
    transcript: {
      aborted: [],
      inputs: [
        { id: "waiting", mode: "queue", status: "outstanding", text: "Do this later", seq: 1 },
        { id: "current", mode: "queue", status: "outstanding", text: "Do this now", seq: 2 },
      ],
      events: [
        {
          seq: 3,
          epoch: 1,
          turnId: "partial",
          event: { kind: "token", text: "last observed fragment" },
        },
        {
          seq: 4,
          epoch: 1,
          turnId: "partial",
          event: { kind: "limit", code: "rate-limit", message: "Reset at 14:00" },
        },
      ],
    },
  });
  expect(context.history.find((e) => e.id === "input:waiting")?.provenance.status).toBe(
    "outstanding",
  );
  expect(context.history.find((e) => e.id === "event:3")?.provenance.gaps).toBe("possible");
  expect(context.history.find((e) => e.id === "event:4")).toMatchObject({ kind: "failure" });
  expect(JSON.stringify(context)).toContain("Reset at 14:00");
});

test("unclassified event content holds preparation instead of silently losing it or exporting its envelope", () => {
  expect(() =>
    projectConversationContext({
      artifacts: [],
      from: 0,
      through: 3,
      pendingInputId: "next",
      transcript: {
        aborted: [],
        inputs: [{ id: "next", seq: 2, mode: "queue", status: "outstanding", text: "Continue" }],
        events: [
          {
            seq: 1,
            epoch: 1,
            turnId: "previous",
            event: { kind: "new-result-format", payload: "unclassified payload" },
          },
        ],
      },
    }),
  ).toThrow("Unsupported conversation event");
});

test("an unfamiliar tool result field holds context instead of exporting an empty tool result", () => {
  expect(() =>
    projectConversationContext({
      artifacts: [],
      from: 0,
      through: 3,
      pendingInputId: "next",
      transcript: {
        aborted: [],
        inputs: [{ id: "next", seq: 2, mode: "queue", status: "outstanding", text: "Continue" }],
        events: [
          {
            seq: 1,
            epoch: 1,
            turnId: "previous",
            event: { kind: "tool", name: "Read", content: "Result in a future format" },
          },
        ],
      },
    }),
  ).toThrow("Unsupported tool event content");
});

test("a fresh continuation retains interrupted output and failure evidence without repeating completed deltas", () => {
  const context = projectConversationContext({
    artifacts: [],
    from: 0,
    through: 10,
    pendingInputId: "continue",
    transcript: {
      aborted: ["interrupted"],
      inputs: [
        { id: "continue", seq: 10, mode: "queue", status: "outstanding", text: "Finish it" },
      ],
      events: [
        { seq: 1, epoch: 1, turnId: "finished", event: { kind: "token", text: "Ready" } },
        {
          seq: 2,
          epoch: 1,
          turnId: "finished",
          event: { kind: "message", role: "assistant", text: "Ready" },
        },
        { seq: 3, epoch: 2, turnId: "interrupted", event: { kind: "token", text: "Changed " } },
        { seq: 4, epoch: 2, turnId: "interrupted", event: { kind: "token", text: "one file" } },
        {
          seq: 5,
          epoch: 2,
          turnId: "interrupted",
          event: {
            kind: "done",
            cause: "error",
            exitCode: 1,
            failure: { class: "process", message: "Worker lost", code: "E_CHILD" },
          },
        },
      ],
    },
  });
  expect(context.history.filter((e) => e.text === "Ready")).toHaveLength(1);
  expect(
    context.history
      .filter((e) => e.provenance.turnId === "interrupted")
      .map((e) => e.text)
      .join(" "),
  ).toContain("one file");
  expect(context.history).toContainEqual(
    expect.objectContaining({
      role: "assistant",
      text: "Changed ",
      provenance: expect.objectContaining({ completeness: "partial", interrupted: "true" }),
    }),
  );
  expect(JSON.stringify(context)).toContain("Worker lost");
  expect(JSON.stringify(context)).toContain("E_CHILD");
});
