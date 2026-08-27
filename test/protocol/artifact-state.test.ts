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

describe("sending the agent its own document back after a patch missed", () => {
  const missed: ArtifactState = {
    artifactId: "doc-1",
    version: 4,
    author: "agent",
    bytes: "<ul><li>alpha</li></ul>",
  };

  test("a version the agent wrote is normally not included", () => {
    // The default, and the reason this ticket exists: the agent has its own
    // versions already, so sending them back is context spent for nothing.
    const out = composeArtifactState("go", [agentWrote]);
    // No document block at all. ("in full" also appears in the closing
    // instruction, so the fence is what actually distinguishes them.)
    expect(out).not.toContain("```");
  });

  test("after a missed anchor, its own current version is included whole", () => {
    const out = composeArtifactState("go", [missed]);
    expect(out).toContain("<ul><li>alpha</li></ul>");
  });

  test("it says the bytes are its own version, not somebody else's edit", () => {
    // Without this the agent reads a resend as a change it has to reconcile,
    // and spends the retry working out what moved.
    const out = composeArtifactState("go", [missed]);
    expect(out).toContain("your patch did not match");
    expect(out).not.toContain("what they saved");
  });

  test("a person's save still reads as a person's save", () => {
    const out = composeArtifactState("go", [{ ...personSaved, bytes: "<p>theirs</p>" }]);
    expect(out).toContain("what they saved");
    expect(out).not.toContain("your patch did not match");
  });

  test("a document too large is never truncated, and says to emit the whole form", () => {
    // An anchor written against half a document is a miss the agent cannot
    // see coming, and it would spend the very retry this resend is for.
    const huge = "z".repeat(ARTIFACT_STATE_BYTES_MAX + 1);
    const out = composeArtifactState("go", [{ ...missed, bytes: huge }]);
    expect(out).not.toContain(huge);
    expect(out).toContain("too large to include here");
    expect(out).toContain("whole document");
    expect(out.length).toBeLessThan(ARTIFACT_STATE_BYTES_MAX);
  });

  test("an artifact carrying no bytes is listed without a document", () => {
    // Which artifacts carry bytes is decided upstream, in `artifactState`;
    // this layer renders what it is handed. The pairing tested here is that
    // no bytes means no document block, so an artifact nobody asked about
    // costs one line.
    const out = composeArtifactState("go", [missed, agentWrote]);
    expect(out).toContain("<ul><li>alpha</li></ul>");
    expect(out).toContain("- doc-1");
    expect(out.match(/```/g)?.length).toBe(2);
  });
});

describe("a retired artifact is still named to the agent", () => {
  const retired: ArtifactState = {
    artifactId: "old-doc",
    version: 3,
    author: "agent",
    retired: true,
  };

  test("it is in the block, and marked", () => {
    // Withholding it would leave the agent to discover the state by being
    // refused, for a reason it could not see.
    const out = composeArtifactState("go", [retired]);
    expect(out).toContain("old-doc");
    expect(out).toContain("RETIRED");
  });

  test("the block says what retired means and what to do about it", () => {
    const out = composeArtifactState("go", [retired]);
    expect(out).toContain("Nothing was deleted");
    expect(out).toContain("do not revise it unless they ask");
  });

  test("an artifact in use is not marked, and the note is absent", () => {
    const out = composeArtifactState("go", [agentWrote]);
    expect(out).not.toContain("RETIRED");
    expect(out).not.toContain("Nothing was deleted");
  });

  test("one retired artifact alongside others marks only that one", () => {
    const out = composeArtifactState("go", [agentWrote, retired]);
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.filter((l) => l.includes("RETIRED")).length).toBe(1);
    expect(lines.length).toBe(2);
  });
});
