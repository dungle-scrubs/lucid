/**
 * What the agent is told about the artifacts already in the record.
 *
 * Two failures this answers, both seen in a live conversation:
 *
 * 1. The agent had emitted version 1, a person saved version 2, and nothing
 *    told it. Its next revision would have named a stale version and been
 *    refused, for a reason neither side could see.
 * 2. A person ticked boxes and typed a name, and the agent had no way to
 *    know any of it had happened.
 */
import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_STATE_BYTES_MAX,
  ARTIFACT_STATE_MARKER,
  type ArtifactState,
  composeArtifactState,
} from "../../src/protocol/artifacts.js";

const agentWrote: ArtifactState = { artifactId: "doc-1", version: 3, author: "agent" };
const personSaved: ArtifactState = {
  artifactId: "todo",
  version: 2,
  author: "human",
  basedOn: 1,
  values: { e5: "on", e14: "Kevin" },
};

describe("telling the agent what the record holds", () => {
  test("nothing is added when there are no artifacts", () => {
    expect(composeArtifactState("hello", [])).toBe("hello");
  });

  test("the current version is named, so `replaces` is not a guess", () => {
    const out = composeArtifactState("revise it", [agentWrote]);
    expect(out.startsWith(ARTIFACT_STATE_MARKER)).toBe(true);
    expect(out).toContain("doc-1 — current version 3");
    expect(out).toContain("set `replaces` to the current version");
    expect(out.endsWith("revise it")).toBe(true);
  });

  test("a version the person saved says so, and what they left in the controls", () => {
    const out = composeArtifactState("what do you think", [personSaved]);
    expect(out).toContain("todo — current version 2, saved by the person");
    // The half of a save that the document cannot express on its own.
    expect(out).toContain('{"e5":"on","e14":"Kevin"}');
    expect(out).toContain("working from version 1");
  });

  test("a version the agent wrote carries no values", () => {
    const out = composeArtifactState("go on", [agentWrote]);
    expect(out).toContain("written by you");
    expect(out).not.toContain("controls as they left them");
  });

  test("a version the agent wrote is not read back to it", () => {
    const out = composeArtifactState("go on", [agentWrote]);
    // It wrote those bytes. Repeating them costs a prompt and tells it
    // nothing.
    expect(out).not.toContain("what they saved, in full");
  });

  test("a version a person saved travels in full", () => {
    // The failure this answers, found by using it: a person edited a
    // sentence, saved, and asked the agent for an unrelated change. The
    // agent revised from the last version IT wrote, and the sentence was
    // gone from the next version with nothing said by either side.
    //
    // Control values are not enough. They carry a ticked box; they carry
    // nothing of a rewritten sentence.
    const out = composeArtifactState("go on", [
      { ...personSaved, bytes: "<p>a sentence they rewrote</p>" },
    ]);
    expect(out).toContain("what they saved, in full");
    expect(out).toContain("a sentence they rewrote");
    expect(out).toContain("revise from that and not from the last one you wrote");
  });

  test("a version too large to carry says so, and says what to do", () => {
    const big = "x".repeat(ARTIFACT_STATE_BYTES_MAX + 1);
    const out = composeArtifactState("go on", [{ ...personSaved, bytes: big }]);
    expect(out).not.toContain(big);
    expect(out).toContain("too large to include here");
    // The old wording told the agent to "ask if you need to see them", which
    // it cannot do: this is a one-way prompt with no way to ask. Saying what
    // is missing and why it matters is the most that can be true here.
    expect(out).toContain("Ask for it before revising");
    expect(out).not.toContain("ask if you need to see them");
  });

  test("several artifacts are all named", () => {
    const out = composeArtifactState("go on", [agentWrote, personSaved]);
    expect(out).toContain("doc-1");
    expect(out).toContain("todo");
  });

  test("composing twice does not say it twice", () => {
    const once = composeArtifactState("go on", [agentWrote]);
    expect(composeArtifactState(once, [agentWrote])).toBe(once);
  });

  test("an empty values map is not mentioned", () => {
    const out = composeArtifactState("go on", [{ ...personSaved, values: {} }]);
    expect(out).toContain("saved by the person");
    expect(out).not.toContain("controls as they left them");
  });
});
