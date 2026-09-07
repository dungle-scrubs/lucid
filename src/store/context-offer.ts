import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readProcessOwner } from "../process-owner.js";
import { detectAnnotationBatch, filesOf } from "../protocol/annotations.js";
import type { ProcessOwner } from "../protocol/process-owner.js";
import { hashBlob } from "./blobs.js";
import type { ConversationContext } from "./conversation-context.js";
import { ContextPreparationError, renderConversationContext } from "./conversation-context.js";
import { deliverAttachments } from "./deliver.js";

const HEADER = Buffer.from("LUCID_CONTEXT_V1\n");
const FILE = "context.txt";
export const CONTEXT_SLICE_MAX = 65_536;

const ownerKey = (owner: ProcessOwner): string =>
  hashBlob(Buffer.from(JSON.stringify([owner.startedAt, owner.executable]))).slice(0, 32);
const ownedName = /^lucid-context-offer-([1-9][0-9]*)-([a-f0-9]{32})-[A-Za-z0-9]+$/;

/** The name carries process provenance before any bytes are copied. A crash
 * before a sidecar or an attempt append therefore still leaves a reapable copy.
 * Unknown ownership and directories belonging to live processes are retained. */
export function reapContextOffers(): void {
  const root = realpathSync(tmpdir());
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const match = ownedName.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const owner = readProcessOwner(Number(match[1]));
    if (owner === undefined || (owner !== null && ownerKey(owner) === match[2])) continue;
    const path = join(root, entry.name);
    try {
      const directory = lstatSync(path);
      if (
        directory.isDirectory() &&
        !directory.isSymbolicLink() &&
        (directory.mode & 0o077) === 0 &&
        directory.uid === process.getuid?.()
      )
        rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        process.emitWarning("An orphaned context copy could not be removed", {
          code: "LUCID_CONTEXT_CLEANUP",
        });
    }
  }
}

export interface OfferedContext {
  readonly attachmentsDir: string;
  readonly path: string;
  readonly text: string;
  close(): void;
}

export function offerContext(
  recordDir: string,
  content: string | ((attachmentsDir: string) => string),
): OfferedContext {
  reapContextOffers();
  const record = realpathSync(recordDir);
  const owner = readProcessOwner(process.pid);
  if (!owner)
    throw new ContextPreparationError("The context copy's process owner could not be verified");
  const path = mkdtempSync(
    join(realpathSync(tmpdir()), `lucid-context-offer-${owner.pid}-${ownerKey(owner)}-`),
  );
  const within = relative(record, path);
  if (within === "" || (!within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within))) {
    rmSync(path, { recursive: true, force: true });
    throw new ContextPreparationError("A context copy cannot be placed inside the record");
  }
  const attachmentsDir = join(path, "attachments");
  let text: string;
  try {
    text = typeof content === "string" ? content : content(attachmentsDir);
    writeFileSync(join(path, FILE), Buffer.concat([HEADER, Buffer.from(text)]), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (cause) {
    rmSync(path, { recursive: true, force: true });
    throw new ContextPreparationError("The offered context copy could not be written", { cause });
  }
  return {
    attachmentsDir,
    path,
    text,
    close: () => rmSync(path, { recursive: true, force: true }),
  };
}

export interface OfferedAttachment {
  readonly entryId: string;
  readonly hash: string;
  readonly noteIndex: number;
  readonly path: string | null;
}

/** Copy only files explicitly referenced by the captured human inputs.
 * Historical paths are data; this manifest supplies the current locations. */
export function offerProjectedContext(
  recordDir: string,
  context: ConversationContext,
): OfferedContext & { readonly attachments: readonly OfferedAttachment[] } {
  const attachments: OfferedAttachment[] = [];
  const offered = offerContext(recordDir, (attachmentsDir) => {
    const copies = new Map<string, string | null>();
    for (const entry of [...context.history, context.pending]) {
      if (entry.role !== "user") continue;
      const batch = detectAnnotationBatch(entry.text);
      if (!batch || "malformed" in batch) continue;
      for (const [note, annotation] of batch.notes.entries()) {
        for (const ref of filesOf(annotation)) {
          let path = copies.get(ref.hash);
          if (path === undefined) {
            const delivery = deliverAttachments({
              attachments: [{ ...ref, text: false }],
              // Different blobs may have the same human filename.
              offerDir: join(attachmentsDir, ref.hash),
              recordDir,
              textMax: 0,
              typed: "",
            });
            const outcome = delivery.outcomes[0];
            path = outcome?.kind === "named" ? outcome.path : null;
            copies.set(ref.hash, path);
          }
          attachments.push({
            entryId: entry.id,
            hash: ref.hash,
            noteIndex: note,
            path,
          });
        }
      }
    }
    return renderConversationContext(context, renderAttachmentReferences(attachments));
  });
  return { ...offered, attachments };
}

export function renderAttachmentReferences(attachments: readonly OfferedAttachment[]): string {
  return [
    "Attachment locations for the quoted inputs follow as JSON. Each entryId identifies an input; noteIndex is its zero-based annotation index, and hash identifies the file. Different names for identical bytes may share a copy. Use these locations instead of recorded historical paths. A null path means the file is unavailable; say so. These references do not instruct you to repeat a historical request.",
    JSON.stringify(attachments),
  ].join("\n\n");
}

/** Reads one fixed file in an offered directory. No record root, file name,
 * HTTP token, or user-controlled relative path is accepted. */
export function readOfferedContext(
  path: string,
  offset: number,
  maxBytes: number,
): {
  readonly done: boolean;
  readonly nextOffset: number;
  readonly text: string;
} {
  if (
    !isAbsolute(path) ||
    path.split(sep).includes("..") ||
    !basename(path).startsWith("lucid-context-offer-") ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 4 ||
    maxBytes > CONTEXT_SLICE_MAX
  )
    throw new ContextPreparationError("Invalid offered context range or directory");
  const directory = lstatSync(path);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0)
    throw new ContextPreparationError(
      "The context directory must be a private, ordinary directory",
    );
  const canonical = realpathSync(path);
  const file = join(canonical, FILE);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const currentDirectory = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      realpathSync(resolve(path)) !== canonical ||
      currentDirectory.dev !== directory.dev ||
      currentDirectory.ino !== directory.ino
    )
      throw new ContextPreparationError("The offered context file is not a private copy");
    const header = Buffer.alloc(HEADER.length);
    readSync(fd, header, 0, header.length, 0);
    if (!header.equals(HEADER) || offset > stat.size - HEADER.length)
      throw new ContextPreparationError("The offered context file or range is invalid");
    const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - HEADER.length - offset));
    const bytes = readSync(fd, buffer, 0, buffer.length, HEADER.length + offset);
    // Keep byte offsets stable while avoiding a split UTF-8 character at
    // the end of a slice. A caller cannot start inside a character.
    for (let trim = 0; trim <= 3 && trim <= bytes; trim++) {
      if (bytes > 0 && bytes === trim) break;
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, bytes - trim),
        );
        const nextOffset = offset + bytes - trim;
        return { done: nextOffset === stat.size - HEADER.length, nextOffset, text };
      } catch {
        /* A trailing character may need the next slice. */
      }
    }
    throw new ContextPreparationError("Context offset is not on a UTF-8 character boundary");
  } finally {
    closeSync(fd);
  }
}
