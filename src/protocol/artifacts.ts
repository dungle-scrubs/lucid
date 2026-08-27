/**
 * Artifact emission — the deep module that owns the artifact preamble and fence parser.
 *
 * Copies hcn's question mechanism (src/interpretation/question.ts):
 * ESCALATION_PREAMBLE teaches the model a fenced block and its JSON shape,
 * detectQuestionBlock parses it out of the final message. Lucid does the
 * same for artifacts: it composes the text handed to the harness, and
 * receives `message` events.
 *
 * The fence format is decided in RFC-06 Emission:
 *
 * ```lucid-artifact
 * {"id": "<stable across versions>", "replaces": <version|null>, "contentType": "text/html"}
 * <the document>
 * ```
 *
 * - `id` — agent chooses, reused to revise. Unknown id starts new artifact at v1.
 * - `replaces` — version superseded, or null for first. Stale replaces is refused.
 * - `contentType` — what renderer needs.
 * - version, author, hash are lucid's, never agent's.
 *
 * Profile table (RFC-06):
 * - headless-session — preamble once when session opens.
 * - headless-turn — preamble every turn (process does not survive).
 * - interactive — excluded, nowhere to put it.
 */

import { ARTIFACT_BYTES_MAX } from "../store/log.js";

/** Marker — also idempotence check, like QUESTION_PREAMBLE_MARKER. */
export const ARTIFACT_PREAMBLE_MARKER = "[lucid artifact protocol]";

export const ARTIFACT_PREAMBLE = `${ARTIFACT_PREAMBLE_MARKER}
You can emit a document as an artifact. To do so, emit a fenced code block tagged lucid-artifact whose first line is a JSON header and the rest is the document:

\`\`\`lucid-artifact
{"id": "<stable across versions>", "replaces": <version|null>, "contentType": "text/html"}
<the document>
\`\`\`

- \`id\` — you choose it and reuse it to revise. A block with an unknown id starts a new artifact at version 1.
- \`replaces\` — the version this one supersedes, or null for a first emission. Must be the current version; stale is refused.
- \`contentType\` — e.g. "text/html".

Two blocks in one message both land, in order. You do not assign version, author, or hash — lucid does.

To revise a document you have already emitted, you can name what changes instead of retyping the whole thing. Add \`"form": "patch"\` to the header and make the body a JSON object of edits:

\`\`\`lucid-artifact
{"id": "checklist", "replaces": 12, "contentType": "text/html", "form": "patch"}
{"edits": [{"find": "<li>Read the brief</li>", "replace": "<li>Read the brief carefully</li>"}]}
\`\`\`

lucid applies the edits and stores the whole resulting document, exactly as if you had typed it out. What you save is the typing, not the result.

- \`find\` is matched literally against the version named by \`replaces\`: not a regular expression, not a selector, not a line range. It must match exactly once. No match is refused, and so is more than one; lengthen the anchor until it is unique.
- \`replace\` may be empty, which deletes the matched text.
- The order you list edits in does not matter. Every anchor is found in the version named by \`replaces\` before any edit is applied, so an edit CANNOT anchor on text another edit in the same patch introduces. If a change needs that, emit the whole document instead.
- Two edits that cover overlapping text are refused. So is an unknown field on an edit: only \`find\` and \`replace\` exist.
- A patch is a revision, never a creation. \`replaces\` must name an existing version, so the first emission of any document is always the whole form.
- If any edit fails the whole patch is refused and nothing is stored. The refusal says which edit and why, so fix that edit and send it again. Nothing is ever half-applied.

Emitting the whole document is always allowed and is never wrong. Use it when the document is short, when you are unsure what the current version holds, or when one edit needs to build on another. A patch that has to guess costs more than the document it was avoiding.`;

/** What the body after the header is.
 *
 * `whole` is the document itself, which is every block RFC-06 defines and
 * stays the default. `patch` is a description of edits to the version named
 * by `replaces` (RFC-08), which lucid applies to produce the document.
 *
 * There is no third value, and an unrecognised one is refused rather than
 * assumed: guessing `whole` for a form lucid does not know would store a body
 * that is not a document as though it were one. */
export type ArtifactForm = "whole" | "patch";

export type ArtifactHeader = {
  readonly id: string;
  readonly replaces: number | null;
  readonly contentType: string;
  /** Always set. An absent `form` is normalised to `whole` here so no reader
   * downstream has to remember the default. */
  readonly form: ArtifactForm;
};

export interface ArtifactBlock {
  readonly header: ArtifactHeader;
  readonly bytes: string;
  readonly rawBody: string;
}

export type ArtifactDetection =
  | { readonly block: ArtifactBlock }
  | { readonly malformed: string; readonly rawBody: string };

// Validation mirrors isArtifactField in store/log.ts — non-empty, <=128, no control chars.
// biome-ignore lint/suspicious/noControlCharactersInRegex: artifact fields must not contain control chars — mirrors frames.ts guard
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const isField = (v: unknown): boolean =>
  typeof v === "string" && v.length > 0 && v.length <= 128 && !CONTROL_CHARS.test(v);

/** How much agent-supplied text a refusal reason may quote back (RFC-08 R7).
 *
 * A refusal names what it refused, which means putting agent text into the
 * log. Unbounded, that is a way to write arbitrary length into the record by
 * sending something invalid. */
export const REFUSAL_QUOTE_MAX = 200;

/** Agent text, safe to put in a refusal reason: JSON-quoted so control
 * characters cannot break the line, and cut to the bound. */
export const quoteForRefusal = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length <= REFUSAL_QUOTE_MAX ? s : `${s.slice(0, REFUSAL_QUOTE_MAX)}…`;
};

const FENCE_OPEN = /(?:^|\n)[ \t]*```[ \t]*lucid-artifact[ \t]*(?=\n)/g;

interface FenceCandidate {
  readonly body: string;
  readonly closed: boolean;
}

const fenceBodies = (text: string): FenceCandidate[] => {
  const out: FenceCandidate[] = [];
  FENCE_OPEN.lastIndex = 0;
  for (let m = FENCE_OPEN.exec(text); m !== null; m = FENCE_OPEN.exec(text)) {
    const bodyStart = m.index + m[0].length;
    const close = text.slice(bodyStart).search(/\n[ \t]*```/);
    if (close === -1) {
      out.push({ body: text.slice(bodyStart), closed: false });
      break;
    }
    const bodyEnd = bodyStart + close;
    out.push({ body: text.slice(bodyStart, bodyEnd), closed: true });
    FENCE_OPEN.lastIndex = bodyEnd;
  }
  return out;
};

const parseHeader = (body: string): ArtifactDetection => {
  const trimmed = body.trim();
  if (trimmed === "") return { malformed: "lucid-artifact block is empty", rawBody: body };
  const nl = trimmed.indexOf("\n");
  let headerJson: string;
  let bytes: string;
  if (nl === -1) {
    headerJson = trimmed;
    bytes = "";
  } else {
    headerJson = trimmed.slice(0, nl).trim();
    bytes = trimmed.slice(nl + 1);
    // Preserve bytes exactly as authored inside fence, but strip one leading newline artefact
    // Do not trim bytes — whitespace may be meaningful in HTML.
  }
  let raw: unknown;
  try {
    raw = JSON.parse(headerJson);
  } catch (e) {
    return {
      malformed: `lucid-artifact header is not valid JSON: ${(e as Error).message}`,
      rawBody: body,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { malformed: "lucid-artifact header must be a JSON object", rawBody: body };
  }
  const obj = raw as Record<string, unknown>;
  const { id, replaces, contentType, form } = obj;
  if (!isField(id))
    return {
      malformed:
        'lucid-artifact header field "id" must be a non-empty string <=128 without control chars',
      rawBody: body,
    };
  if (!isField(contentType))
    return {
      malformed: 'lucid-artifact header field "contentType" must be a non-empty string <=128',
      rawBody: body,
    };
  if (
    replaces !== null &&
    (typeof replaces !== "number" || !Number.isSafeInteger(replaces) || replaces < 1)
  ) {
    return {
      malformed: 'lucid-artifact header field "replaces" must be a version number >=1 or null',
      rawBody: body,
    };
  }
  // E-PATCH-07. Absent means `whole`, so every block written before RFC-08
  // keeps its meaning and no agent has to change what it emits.
  if (form !== undefined && form !== "whole" && form !== "patch") {
    return {
      malformed: `E-PATCH-07 unknown-form: lucid-artifact header field "form" must be "whole" or "patch", not ${quoteForRefusal(form)}`,
      rawBody: body,
    };
  }
  // bytes may be any string (including empty), but size is checked by caller
  return {
    block: {
      header: {
        id: id as string,
        replaces: replaces as number | null,
        contentType: contentType as string,
        form: form === "patch" ? "patch" : "whole",
      },
      bytes,
      rawBody: body,
    },
  };
};

export const detectArtifactBlocks = (text: string): ArtifactDetection[] => {
  const candidates = fenceBodies(text);
  const out: ArtifactDetection[] = [];
  for (const c of candidates) {
    // Closed check not strictly required — unclosed still examined as maybe valid, but mark malformed if unclosed and not parseable?
    // Follow question.ts: unclosed still examined, closed false not treated as absent.
    const parsed = parseHeader(c.body);
    out.push(parsed);
  }
  return out;
};

/** Compose preamble onto a prompt. Idempotent via marker. */
export const composeArtifactPrompt = (
  prompt: string,
  profile: "headless-session" | "headless-turn" | "interactive",
): string => {
  if (profile === "interactive") return prompt;
  if (prompt.startsWith(ARTIFACT_PREAMBLE_MARKER)) return prompt;
  return `${ARTIFACT_PREAMBLE}\n\n${prompt}`;
};

/** View helpers — strip fence and render placeholder. */
export const stripArtifactBlocks = (text: string): string => {
  // Replace each fence with placeholder derived from header if parsable
  let stripped = text;
  // Use fenceBodies to get accurate bodies, but replace via regex with function for simplicity
  // We replace via global regex capturing body indirectly — use replace with callback that parses header
  stripped = stripped.replace(/```lucid-artifact[\s\S]*?```/g, (match) => {
    // Extract body between fences
    const inner = match.replace(/^```[ \t]*lucid-artifact[ \t]*\n/, "").replace(/\n[ \t]*```$/, "");
    const parsed = parseHeader(inner);
    if ("malformed" in parsed) {
      return `[artifact malformed: ${parsed.malformed}]`;
    }
    const h = parsed.block.header;
    const version = h.replaces === null ? 1 : h.replaces + 1;
    // Size check for view — show too-large hint but still not bytes
    if (parsed.block.bytes.length > ARTIFACT_BYTES_MAX) {
      return `[artifact ${h.id} v${version} — too large, not stored]`;
    }
    return `[artifact ${h.id} v${version}]`;
  });
  // Handle unclosed fence at end (no closing ```) — strip from opener to end
  stripped = stripped.replace(/(?:^|\n)[ \t]*```[ \t]*lucid-artifact[ \t]*\n[\s\S]*$/g, (match) => {
    const inner = match.replace(/^(?:\n)?[ \t]*```[ \t]*lucid-artifact[ \t]*\n/, "");
    const parsed = parseHeader(inner);
    if ("malformed" in parsed) return `[artifact malformed: ${parsed.malformed}]`;
    const h = parsed.block.header;
    const version = h.replaces === null ? 1 : h.replaces + 1;
    return `[artifact ${h.id} v${version}]`;
  });
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
};

export const artifactPlaceholder = (header: ArtifactHeader): string => {
  const v = header.replaces === null ? 1 : header.replaces + 1;
  return `[artifact ${header.id} v${v}]`;
};

/** What the agent is told about the artifacts already in the record.
 *
 * Never the document bytes. The current version number, who wrote it, and
 * — when a person saved it — the values of the controls they left, which
 * are small and structured and are the half of a save that a document
 * cannot express on its own. */
/** How much of a person's saved document travels with the prompt. Large
 * enough for the documents this surface is for, small enough that a prompt
 * stays a prompt. Over it, the agent is told plainly that it cannot see the
 * version rather than being left to guess. */
export const ARTIFACT_STATE_BYTES_MAX = 60_000;

export interface ArtifactState {
  readonly artifactId: string;
  readonly version: number;
  readonly author: string;
  /** Present when this version was saved by a person. */
  readonly basedOn?: number;
  readonly values?: Readonly<Record<string, string>>;
  /** The bytes of the current version, when the agent needs to see them.
   *
   * Two reasons, and `author` tells them apart, so there is no third state
   * where the two disagree. A person saved it, and the agent has never seen
   * it. Or the agent wrote it and its own patch just failed to anchor
   * against it, which is the one case where "it has those already" is false.
   *
   * Absent otherwise. */
  readonly bytes?: string;
  /** True when this artifact has been retired (RFC-07 R12).
   *
   * A retired artifact stays in this block. The agent is told it exists and
   * that it is retired: an agent revising an artifact nobody told it was
   * retired is a worse failure than a longer block, and it would be refused
   * for a reason it could not see. */
  readonly retired?: boolean;
}

export const ARTIFACT_STATE_MARKER = "[lucid artifact state]";

/** Tell the agent what the record currently holds.
 *
 * Two failures this answers, both seen in a live conversation:
 *
 * 1. The agent guessed at `replaces`. It had emitted version 1, a person
 *    saved version 2, and nothing told it — so its next revision would have
 *    named a stale version and been refused, for a reason neither side
 *    could see.
 * 2. A save was invisible. A person ticked boxes and typed a name, and the
 *    agent had no way to know any of it had happened.
 *
 * The document itself is not included. It can be large, most turns do not
 * need it, and the annotation path already carries the person's own text in
 * the snippet when they wrote about something they had edited. */
export const composeArtifactState = (
  prompt: string,
  artifacts: readonly ArtifactState[],
): string => {
  if (artifacts.length === 0) return prompt;
  if (prompt.startsWith(ARTIFACT_STATE_MARKER)) return prompt;
  const lines = [ARTIFACT_STATE_MARKER, "Artifacts in this conversation right now:"];
  for (const a of artifacts) {
    const who = a.author === "human" ? "saved by the person" : `written by you (${a.author})`;
    // Named, and marked. Withholding it would leave the agent to discover
    // the state by being refused.
    const mark = a.retired === true ? ", RETIRED" : "";
    lines.push(`- ${a.artifactId} — current version ${a.version}, ${who}${mark}`);
    if (a.basedOn !== undefined) {
      lines.push(`  they were working from version ${a.basedOn}`);
    }
    if (a.values !== undefined && Object.keys(a.values).length > 0) {
      lines.push(`  controls as they left them: ${JSON.stringify(a.values)}`);
    }
    // A version a person saved is the only one the agent has not written
    // itself, so it is the only one it cannot otherwise know. Without it the
    // agent revises from the last version IT wrote, and every word the person
    // typed is dropped from the next version without either side noticing.
    //
    // Control values alone are not enough. They carry a ticked box and a
    // filled field; they carry nothing of a sentence rewritten in place.
    if (a.bytes !== undefined) {
      // Its own version is only ever here because a patch missed.
      const mine = a.author !== "human";
      if (a.bytes.length <= ARTIFACT_STATE_BYTES_MAX) {
        lines.push(
          mine
            ? "  your patch did not match this version. Here it is in full, so the next anchor comes from the document and not from memory:"
            : "  what they saved, in full:",
        );
        lines.push("  ```");
        for (const line of a.bytes.split("\n")) lines.push(`  ${line}`);
        lines.push("  ```");
      } else {
        // Never a truncated document. An anchor written against half a
        // document is a miss the agent cannot see coming, and it would spend
        // the retry this resend exists to make count.
        lines.push(
          mine
            ? `  your patch did not match this version, and at ${a.bytes.length} bytes it is too large to include here. Emit the whole document rather than another patch: a patch written from memory has already missed once.`
            : `  their version is ${a.bytes.length} bytes, too large to include here. Ask for it before revising: revising from your own last version would drop whatever they changed.`,
        );
      }
    }
  }
  lines.push("");
  if (artifacts.some((a) => a.retired === true)) {
    lines.push("");
    lines.push(
      "A RETIRED artifact is one the person has finished with. Nothing was deleted and every version is still here, but do not revise it unless they ask for it back.",
    );
  }
  lines.push(
    "When you revise one of these, set `replaces` to the current version above. Where a version a person saved is shown in full, revise from that and not from the last one you wrote, or their changes are lost.",
  );
  return `${lines.join("\n")}\n\n${prompt}`;
};
