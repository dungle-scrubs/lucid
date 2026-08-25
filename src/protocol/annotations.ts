/**
 * An annotation batch: what a person said, and what they said it about.
 *
 * A batch rides in the input text, taught by a preamble, exactly as an
 * artifact block does. No frame gains a field and no protocol version
 * changes (RFC-06, Encoding). A batch is **one input**: one idempotent id,
 * one disposition, one turn, one charge against `INPUT_QUEUE_MAX` —
 * however many notes are in it.
 *
 * Two properties the shape exists to carry:
 *
 * - **The snippet travels, not a reference.** What was on screen where the
 *   note points is captured when the note is written. A reference would
 *   have to be resolved later, against a document that may have changed,
 *   and the agent would be reading something the person never saw.
 * - **Provenance is per spot, not per note.** One note can cover text the
 *   agent wrote and text the person wrote. Without per-spot authorship the
 *   agent reads all of it as its own work, and may defend a sentence it
 *   never wrote.
 *
 * lucid does not tell the agent where to put its answer. The preamble says
 * what was said and where it sits, and stops.
 */

/** Marks a prompt that already carries the teaching, so composing twice
 * does not say it twice. */
export const ANNOTATION_PREAMBLE_MARKER = "[lucid annotation protocol]";

export const ANNOTATION_PREAMBLE = `${ANNOTATION_PREAMBLE_MARKER}
The person marked up a document you produced and wrote notes against what they marked. Their notes arrive as a fenced code block tagged lucid-annotations:

\`\`\`lucid-annotations
{"artifactId": "<id>", "version": <n>, "notes": [
  {"note": "<what they wrote>", "spots": [{"id": "<element>", "snippet": "<what was there>", "author": "agent|human"}]}
]}
\`\`\`

- Each note names one or more spots. A note with several spots is about all of them together.
- \`snippet\` is what was on screen where the note points, captured when the note was written.
- \`author\` says who wrote the content in that spot. A spot authored \`human\` is their text, not yours — do not defend it as your own.

Answer by emitting a new version of THIS artifact: reuse the \`artifactId\` the block names as your \`id\`, and set \`replaces\` to the \`version\` it names. A different id starts an unrelated document and loses the thread.

Where the change belongs inside the document is your judgement: at the spot, somewhere else, or spread across it.`;

/** The fence tag. One name for it, used by the encoder, the detector, and
 * the projection. */
export const ANNOTATION_FENCE = "lucid-annotations";

/** A snippet is what was on screen, not a document. Capped so a batch of
 * notes against large elements cannot approach the input text bound on its
 * own; the cap is applied when the snippet is captured, so what the agent
 * reads is what lucid sent. */
export const SNIPPET_MAX = 2000;

export interface AnnotationSpot {
  /** lucid's element id, from the render the note was made against. */
  readonly id: string;
  readonly snippet: string;
  /** Who wrote the content in this spot. */
  readonly author: string;
  /** Three ways of finding this spot again after the agent has rewritten
   * the document, written when the note was made and tried in order. Absent
   * on a note written before anchoring existed, which is why it is optional
   * rather than required: such a note still shows, it just cannot follow a
   * rewrite. */
  readonly selectors?: {
    readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
    readonly position: { readonly start: number; readonly end: number };
    readonly css: string;
  };
}

export interface Annotation {
  readonly note: string;
  readonly spots: readonly AnnotationSpot[];
}

export interface AnnotationBatch {
  readonly artifactId: string;
  readonly version: number;
  readonly notes: readonly Annotation[];
}

/** Trim a captured snippet to the cap, marking that it was cut so the
 * agent does not read a truncated sentence as the whole of one. */
export const clampSnippet = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_MAX ? flat : `${flat.slice(0, SNIPPET_MAX)}…`;
};

/** The batch, as it travels: a fenced block appended to whatever the
 * person also typed. */
export const encodeAnnotationBatch = (batch: AnnotationBatch, typed = ""): string => {
  const block = `\`\`\`${ANNOTATION_FENCE}\n${JSON.stringify(batch)}\n\`\`\``;
  return typed.trim() === "" ? block : `${typed.trim()}\n\n${block}`;
};

const isSelectors = (v: unknown): boolean => {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  const q = s.quote as Record<string, unknown> | undefined;
  const p = s.position as Record<string, unknown> | undefined;
  return (
    typeof s.css === "string" &&
    q !== undefined &&
    typeof q.exact === "string" &&
    typeof q.prefix === "string" &&
    typeof q.suffix === "string" &&
    p !== undefined &&
    typeof p.start === "number" &&
    typeof p.end === "number"
  );
};

const isSpot = (v: unknown): v is AnnotationSpot => {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.snippet !== "string" || typeof s.author !== "string")
    return false;
  // Selectors are optional, but a malformed set is not the same as none:
  // carrying it would let a broken anchor be tried and trusted.
  return s.selectors === undefined || isSelectors(s.selectors);
};

const isNote = (v: unknown): v is Annotation => {
  if (v === null || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return typeof n.note === "string" && Array.isArray(n.spots) && n.spots.every(isSpot);
};

const isBatch = (v: unknown): v is AnnotationBatch => {
  if (v === null || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.artifactId === "string" &&
    typeof b.version === "number" &&
    Array.isArray(b.notes) &&
    b.notes.every(isNote)
  );
};

const FENCE_RE = new RegExp(
  `\`\`\`[ \\t]*${ANNOTATION_FENCE}[ \\t]*\\n([\\s\\S]*?)\\n?\`\`\``,
  "g",
);

/** The batch carried in this text, or null. A malformed block is not a
 * batch: the projection shows it as malformed rather than pretending the
 * person said nothing. */
export const detectAnnotationBatch = (
  text: string,
): AnnotationBatch | { malformed: string } | null => {
  FENCE_RE.lastIndex = 0;
  const m = FENCE_RE.exec(text);
  if (m === null) return null;
  const body = m[1] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { malformed: "header is not JSON" };
  }
  if (!isBatch(parsed)) return { malformed: "not an annotation batch" };
  return parsed;
};

/** Prepend the teaching when, and only when, the text carries a batch.
 * An ordinary send is not the moment to explain a protocol it does not
 * use, and every prompt is not the place to pay for it. */
export const composeAnnotationPrompt = (text: string): string => {
  if (text.startsWith(ANNOTATION_PREAMBLE_MARKER)) return text;
  const found = detectAnnotationBatch(text);
  if (found === null || "malformed" in found) return text;
  return `${ANNOTATION_PREAMBLE}\n\n${text}`;
};

/** What a reader sees instead of the encoding.
 *
 * The log keeps the raw text; this is the view. Same split the question
 * block already uses, and the same reason: the log is the truth, the view
 * is a view. */
export const stripAnnotationBatch = (text: string): string => {
  FENCE_RE.lastIndex = 0;
  const out = text.replace(FENCE_RE, (_match, body: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return "[annotations malformed]";
    }
    if (!isBatch(parsed)) return "[annotations malformed]";
    const lines = [
      `[${parsed.notes.length} note${parsed.notes.length === 1 ? "" : "s"} on ${parsed.artifactId} v${parsed.version}]`,
    ];
    for (const n of parsed.notes) {
      lines.push(`  "${n.note}"`);
      for (const s of n.spots) {
        const short = s.snippet.length > 60 ? `${s.snippet.slice(0, 60)}…` : s.snippet;
        lines.push(`    on "${short}" (${s.author})`);
      }
    }
    return lines.join("\n");
  });
  return out.replace(/\n{3,}/g, "\n\n").trim();
};
