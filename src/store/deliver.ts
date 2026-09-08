/**
 * Getting an attachment to the agent, as far as it can go (RFC-11).
 *
 * `hcn` accepts prompt text or a prompt file and nothing else, so there is no
 * channel for an attachment and lucid cannot make one. What lucid can do is
 * put text into the input, put everything else somewhere the agent may be able
 * to read, and be exact about which happened.
 *
 * ## The offered path
 *
 * A named attachment is **never** offered at its path inside the record.
 * `secret` sits beside `files/`, and `secret` is the credential that
 * authenticates a driver to the host - so naming an inside-record path is not
 * a location leak to be weighed against convenience, it hands over the ability
 * to attach to the conversation. The blob is copied to a directory outside the
 * record, readable only by the user lucid runs as, and that copy is named.
 *
 * The guard elsewhere - resolve a blob name as sha256 hex before touching the
 * filesystem - protects the **browser**, which asks lucid for bytes. It does
 * nothing here. The agent reads the filesystem itself, so the only control is
 * which path lucid says out loud.
 *
 * ## What is never claimed
 *
 * Naming a file is not delivering it. Whether the agent opens it depends on
 * its tool grant and its sandbox, neither of which lucid controls, and no
 * event reports it. So this module reports what it *did* - inlined, named,
 * missing - and never that something was read.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTextBytes } from "../protocol/attachment.js";
import { getBlob } from "./blobs.js";

/** An attachment as the record describes it. */
export interface AttachmentRef {
  readonly hash: string;
  readonly contentType: string;
  readonly name: string;
  /** What was decided about the bytes when they arrived. */
  readonly text: boolean;
}

export type Outcome =
  /** The contents are in the input. */
  | { readonly kind: "inlined"; readonly ref: AttachmentRef; readonly chars: number }
  /** The input says where it is. Whether the agent looks is its business. */
  | { readonly kind: "named"; readonly ref: AttachmentRef; readonly path: string }
  /** Its bytes are gone. The input says so and the turn still runs. */
  | { readonly kind: "missing"; readonly ref: AttachmentRef };

export interface Delivery {
  /** The input as it will be sent. */
  readonly text: string;
  /** What happened to each attachment, in the order given. */
  readonly outcomes: readonly Outcome[];
}

/** How an inlined file is introduced. Plain, because four harnesses read it
 * and the preamble teaches no syntax for this. */
const inlineBlock = (ref: AttachmentRef, body: string): string =>
  `\n\nAttached file "${ref.name}" (${ref.contentType}):\n\n${body}`;

/** How a named file is introduced.
 *
 * It says what the file is as well as where, so an agent that cannot open it
 * still knows what it was and can say so. */
const namedLine = (ref: AttachmentRef, path: string, size: number): string =>
  `\n\nAttached file "${ref.name}" (${ref.contentType}, ${size} bytes) is at ${path}. ` +
  "Read it if you can; say so if you cannot.";

const missingLine = (ref: AttachmentRef): string =>
  `\n\nAttached file "${ref.name}" (${ref.contentType}) is no longer available.`;

/**
 * Compose the input, and place whatever has to be placed.
 *
 * `textMax` is the bound the input itself is measured against. A text file
 * that would push the input past it is **named instead of inlined**, not
 * refused: the file was already accepted when it was stored, and refusing it
 * at send time would be accepting something and then rejecting it.
 */
export const deliverAttachments = (opts: {
  readonly recordDir: string;
  /** Where a named attachment is copied to. MUST be outside the record. */
  readonly offerDir: string;
  readonly typed: string;
  readonly attachments: readonly AttachmentRef[];
  readonly textMax: number;
}): Delivery => {
  let text = opts.typed;
  const outcomes: Outcome[] = [];

  for (const ref of opts.attachments) {
    const bytes = getBlob(opts.recordDir, ref.hash);
    if (bytes === null) {
      text += missingLine(ref);
      outcomes.push({ kind: "missing", ref });
      continue;
    }

    // `ref.text` records what was decided when the bytes arrived. It is
    // re-checked here rather than trusted: the entry and the blob are two
    // things, and only one of them is the bytes.
    if (ref.text && isTextBytes(bytes)) {
      const body = new TextDecoder().decode(bytes);
      const block = inlineBlock(ref, body);
      if (text.length + block.length <= opts.textMax) {
        text += block;
        outcomes.push({ kind: "inlined", ref, chars: body.length });
        continue;
      }
      // Too large to inline. It is named, not refused.
    }

    const path = offer(opts.offerDir, ref, bytes);
    text += namedLine(ref, path, bytes.byteLength);
    outcomes.push({ kind: "named", ref, path });
  }

  return { text, outcomes };
};

/** Copy a blob somewhere an agent may read it, outside the record.
 *
 * Named by the person's filename rather than the hash, because the agent is
 * being told to read it and a name it can recognise is worth more than one it
 * can verify. The directory is per turn, so two files with one name never
 * collide across turns.
 *
 * `0o700` on the directory and `0o600` on the file: the record's own files are
 * no more public, and this copy holds the same bytes. */
const offer = (offerDir: string, ref: AttachmentRef, bytes: Uint8Array): string => {
  mkdirSync(offerDir, { recursive: true, mode: 0o700 });
  // The person's filename is theirs, so it is not trusted as a path. Anything
  // that is not an ordinary name becomes the hash, which always is one.
  const safe = /^[\w.-]{1,120}$/.test(ref.name) && !ref.name.startsWith(".") ? ref.name : ref.hash;
  const path = join(offerDir, safe);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
};
