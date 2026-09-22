/**
 * Agent chat references: an agent message quotes a passage's exact words
 * in a `lucid-references` fence, and the browser turns the quote into a
 * link that travels to the block. The log keeps the raw text; the view
 * strips the fence and carries the refs as structured data beside the
 * line. An unmatched quote renders as prose, never a link to the wrong
 * place.
 */

/** The fence tag, shared by the detector, the projection, and the preamble. */
export const CHAT_REFERENCE_FENCE = "lucid-references";

/** A quote is what was on screen, not a document. Capped so a batch of
 * references against large elements cannot approach the message bound on
 * its own; the cap matches the annotation snippet cap, so what the agent
 * quotes is what a note would capture. */
export const CHAT_REFERENCE_QUOTE_MAX = 2000;

/** How many references one message may carry, across all its fences.
 * Bounded for the same reason the note queue is: one message growing
 * without end is one turn growing without end. Enforced across every
 * fence in the message, not per fence. */
export const CHAT_REFERENCE_MAX = 20;

export interface ChatReference {
  /** Exact words from the document, as the agent quotes them. */
  readonly quote: string;
  /** Short name shown on the link, e.g. "Next survey section". */
  readonly label: string;
}

export interface ChatReferenceBlock {
  readonly artifactId: string;
  readonly version: number;
  readonly refs: readonly ChatReference[];
}

const isReference = (v: unknown): v is ChatReference => {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.quote === "string" && typeof r.label === "string";
};

const isBlock = (v: unknown): v is ChatReferenceBlock => {
  if (v === null || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.artifactId === "string" &&
    typeof b.version === "number" &&
    Number.isSafeInteger(b.version) &&
    (b.version as number) >= 1 &&
    Array.isArray(b.refs) &&
    (b.refs as unknown[]).every(isReference)
  );
};

const FENCE_RE = new RegExp(
  `\`\`\`[ \\t]*${CHAT_REFERENCE_FENCE}[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*\`\`\`[ \\t]*(?=\\r?$)`,
  "gm",
);

/** The reference blocks carried in this text, in order. A malformed block
 * is not a reference: the projection shows no link rather than pretending
 * the agent said nothing. Malformed blocks are left in place for the strip
 * step to replace with nothing - the prose around them still reads. */
export const detectChatReferences = (text: string): ChatReferenceBlock[] => {
  FENCE_RE.lastIndex = 0;
  const out: ChatReferenceBlock[] = [];
  let kept = 0;
  for (;;) {
    const m = FENCE_RE.exec(text);
    if (m === null) break;
    const body = m[1] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!isBlock(parsed)) continue;
    // The budget is per message, not per fence: later fences stop
    // contributing once earlier ones filled it. An overlong quote is
    // dropped, not cut: cutting appends a character the document never
    // held, which breaks the verbatim match the link depends on.
    const refs: ChatReference[] = [];
    for (const r of parsed.refs) {
      if (kept >= CHAT_REFERENCE_MAX) break;
      if (r.quote.trim() === "" || r.label.trim() === "") continue;
      if (r.quote.length > CHAT_REFERENCE_QUOTE_MAX || r.label.length > 120) continue;
      refs.push({ quote: r.quote, label: r.label });
      kept += 1;
    }
    if (refs.length === 0) continue;
    out.push({ artifactId: parsed.artifactId, version: parsed.version, refs });
  }
  return out;
};

/** What a reader sees instead of the encoding.
 *
 * The log keeps the raw text; this is the view. The fence is protocol, not
 * prose: it strips to nothing. The agent's own prose already names the
 * location in brackets - "see the [Next survey section]" - and the client
 * turns those brackets into a link where the label resolved against the
 * version on screen. Appending the label again would print it twice. */
export const stripChatReferences = (text: string): string => {
  FENCE_RE.lastIndex = 0;
  const out = text.replace(FENCE_RE, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
};
