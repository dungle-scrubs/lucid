/**
 * The annotation batch: how it travels, what the agent is told, and what a
 * reader sees instead of the encoding.
 */
import { describe, expect, test } from "bun:test";
import {
  ANNOTATION_PREAMBLE_MARKER,
  type AnnotationBatch,
  clampSnippet,
  composeAnnotationPrompt,
  detectAnnotationBatch,
  encodeAnnotationBatch,
  SNIPPET_MAX,
  stripAnnotationBatch,
} from "../../src/protocol/annotations.js";
import { buildView } from "../../src/tui/view.js";

const batch: AnnotationBatch = {
  artifactId: "doc-1",
  version: 2,
  notes: [
    {
      note: "explain further",
      spots: [{ id: "e3", snippet: "Cut the branch", author: "agent" }],
    },
    {
      note: "you forgot this",
      spots: [
        { id: "e5", snippet: "Run the full gate", author: "agent" },
        { id: "e7", snippet: "my own wording", author: "human" },
      ],
    },
  ],
};

describe("a batch travels in the input text", () => {
  test("what goes out comes back", () => {
    const found = detectAnnotationBatch(encodeAnnotationBatch(batch));
    expect(found).not.toBeNull();
    expect(found).toEqual(batch);
  });

  test("a batch can carry what the person also typed", () => {
    const text = encodeAnnotationBatch(batch, "and generally, tighten it");
    expect(text.startsWith("and generally, tighten it")).toBe(true);
    expect(detectAnnotationBatch(text)).toEqual(batch);
  });

  test("text with no batch in it is not one", () => {
    expect(detectAnnotationBatch("just a message")).toBeNull();
  });

  test("a malformed block is malformed, not absent", () => {
    const found = detectAnnotationBatch("```lucid-annotations\nnot json\n```");
    expect(found).not.toBeNull();
    expect(found !== null && "malformed" in found).toBe(true);
  });

  test("a block that parses but is the wrong shape is refused", () => {
    const found = detectAnnotationBatch('```lucid-annotations\n{"artifactId":"d"}\n```');
    expect(found !== null && "malformed" in found).toBe(true);
  });

  test("a note with several spots stays one note", () => {
    const found = detectAnnotationBatch(encodeAnnotationBatch(batch));
    expect(found !== null && !("malformed" in found) && found.notes.length).toBe(2);
    expect(found !== null && !("malformed" in found) && found.notes[1]?.spots.length).toBe(2);
  });
});

describe("the agent is taught only when there is something to teach", () => {
  test("a batch gets the preamble", () => {
    const out = composeAnnotationPrompt(encodeAnnotationBatch(batch));
    expect(out.startsWith(ANNOTATION_PREAMBLE_MARKER)).toBe(true);
  });

  test("an ordinary send does not", () => {
    expect(composeAnnotationPrompt("what time is it")).toBe("what time is it");
  });

  test("composing twice does not say it twice", () => {
    const once = composeAnnotationPrompt(encodeAnnotationBatch(batch));
    expect(composeAnnotationPrompt(once)).toBe(once);
  });

  test("the agent is told what was said and where it sits, not where to answer", () => {
    const out = composeAnnotationPrompt(encodeAnnotationBatch(batch));
    // The one thing the RFC forbids: instructing the agent where to put its
    // response.
    expect(out).toContain("your judgement");
    // Which document to revise is not where to put the answer: naming the
    // artifact keeps the thread, and the RFC's prohibition is about the
    // placement of the change inside it.
    expect(out).toContain("reuse the `artifactId` the block names");
    expect(out).not.toMatch(/replace that element|put your answer (at|in) the spot/i);
  });

  test("per-spot authorship reaches the agent", () => {
    const out = composeAnnotationPrompt(encodeAnnotationBatch(batch));
    expect(out).toContain('"author":"human"');
    expect(out).toContain('"author":"agent"');
    // And the preamble says what that means, so the agent does not defend a
    // sentence it never wrote.
    expect(out).toContain("do not defend it as your own");
  });
});

describe("a reader sees the notes, never the encoding", () => {
  test("the batch renders as notes and the spots they point at", () => {
    const shown = stripAnnotationBatch(encodeAnnotationBatch(batch));
    expect(shown).toContain("2 notes on doc-1 v2");
    expect(shown).toContain('"explain further"');
    expect(shown).toContain('on "Cut the branch" (agent)');
    expect(shown).toContain('on "my own wording" (human)');
    expect(shown).not.toContain("lucid-annotations");
    expect(shown).not.toContain('"artifactId"');
  });

  test("one note reads as one, not as none", () => {
    const shown = stripAnnotationBatch(
      encodeAnnotationBatch({ ...batch, notes: [batch.notes[0] as never] }),
    );
    expect(shown).toContain("1 note on doc-1 v2");
  });

  test("what the person also typed survives beside the notes", () => {
    const shown = stripAnnotationBatch(encodeAnnotationBatch(batch, "and tighten it"));
    expect(shown).toContain("and tighten it");
    expect(shown).toContain("2 notes on doc-1 v2");
  });

  test("the transcript shows it, so the terminal never sees the JSON", () => {
    const view = buildView({
      transcript: {
        events: [],
        inputs: [
          {
            seq: 1,
            id: "i1",
            text: encodeAnnotationBatch(batch),
            mode: "queue",
            status: "applied",
          },
        ],
        aborted: [],
      },
      status: "headless-session",
      rung: "",
      draft: "",
    });
    const text = view.lines.map((l) => l.text).join("\n");
    expect(text).toContain("2 notes on doc-1 v2");
    expect(text).not.toContain("lucid-annotations");
  });
});

describe("a snippet is what was on screen, bounded", () => {
  test("whitespace is flattened, so a snippet reads as one line", () => {
    expect(clampSnippet("  Cut\n  the   branch \n")).toBe("Cut the branch");
  });

  test("an oversized snippet is cut, and says it was", () => {
    const out = clampSnippet("x".repeat(SNIPPET_MAX + 500));
    expect(out.length).toBe(SNIPPET_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  test("a snippet at the cap is not marked as cut", () => {
    const out = clampSnippet("x".repeat(SNIPPET_MAX));
    expect(out.endsWith("…")).toBe(false);
  });
});
