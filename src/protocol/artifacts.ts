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

Two blocks in one message both land, in order. You do not assign version, author, or hash — lucid does.`;

export type ArtifactHeader = {
  readonly id: string;
  readonly replaces: number | null;
  readonly contentType: string;
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
  const { id, replaces, contentType } = obj;
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
  // bytes may be any string (including empty), but size is checked by caller
  return {
    block: {
      header: {
        id: id as string,
        replaces: replaces as number | null,
        contentType: contentType as string,
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
