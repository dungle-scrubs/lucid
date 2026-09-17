import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ownerPresence, readProcessOwner } from "../process-owner.js";
import { detectAnnotationBatch, filesOf } from "../protocol/annotations.js";
import type { ConnectionState } from "../protocol/connection.js";
import type { ProcessOwner } from "../protocol/process-owner.js";
import { atomicSidecar } from "./atomic-file.js";
import { hashBlob } from "./blobs.js";
import type { ConversationContext } from "./conversation-context.js";
import { ContextPreparationError, renderConversationContext } from "./conversation-context.js";
import { deliverAttachments } from "./deliver.js";

const HEADER = Buffer.from("LUCID_CONTEXT_V1\n");
const FILE = "context.txt";
export const CONTEXT_SLICE_MAX = 65_536;

const ownerKey = (owner: ProcessOwner): string =>
  hashBlob(Buffer.from(JSON.stringify([owner.startedAt, owner.executable]))).slice(0, 32);
const ownedName =
  /^lucid-context-offer-([1-9][0-9]*)-([a-f0-9]{32})-(?:([a-f0-9]{64})-)?[A-Za-z0-9]+$/;

function warnCleanup(): void {
  process.emitWarning("A private context copy could not be removed", {
    code: "LUCID_CONTEXT_CLEANUP",
  });
}

function removeContextCopy(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    warnCleanup();
  }
}

function isPrivateDirectory(directory: Stats): boolean {
  return directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0;
}

function sweepContextCopies(remove: (name: RegExpExecArray) => boolean): void {
  try {
    const root = realpathSync(tmpdir());
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const match = ownedName.exec(entry.name);
      if (!entry.isDirectory() || !match || !remove(match)) continue;
      try {
        const path = join(root, entry.name);
        const directory = lstatSync(path);
        if (isPrivateDirectory(directory) && directory.uid === process.getuid?.())
          removeContextCopy(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) warnCleanup();
      }
    }
  } catch {
    warnCleanup();
  }
}

/** The name carries process provenance before any bytes are copied. A crash
 * before a sidecar or an attempt append therefore still leaves a reapable copy.
 * Unknown ownership and directories belonging to live processes are retained. */
export function reapContextOffers(): void {
  sweepContextCopies((match) => {
    const owner = readProcessOwner(Number(match[1]));
    return owner !== undefined && (owner === null || ownerKey(owner) !== match[2]);
  });
}

export interface ContextOfferLifetime {
  readonly offerId?: string;
  readonly owner: ProcessOwner;
}

const scopeKey = (pid: number | string, key: string, offerHash?: string): string =>
  `${pid}-${key}${offerHash === undefined ? "" : `-${offerHash}`}`;

const contextScope = (owner: ProcessOwner, offerId?: string): string =>
  scopeKey(
    owner.pid,
    ownerKey(owner),
    offerId === undefined ? undefined : hashBlob(Buffer.from(offerId)),
  );

function closeContextScopes(scopes: ReadonlySet<string>): void {
  if (scopes.size === 0) return;
  sweepContextCopies((match) => {
    // Legacy copies have no offer scope. Only owner-death reaping can remove them.
    const [, pid, key, offerHash] = match;
    return (
      pid !== undefined &&
      key !== undefined &&
      offerHash !== undefined &&
      scopes.has(scopeKey(pid, key, offerHash))
    );
  });
}

/** Called only after a matching native response is durably accepted. No caller path is accepted. */
export function closeNativeContextOffers(owner: ProcessOwner, offerId: string): void {
  closeContextScopes(new Set([contextScope(owner, offerId)]));
}

/** Durable terminal outcomes also recover cleanup lost between append and process exit. */
export function closeFinishedNativeContextOffers(connection: ConnectionState | null): void {
  if (!connection) return;
  const scopes = new Set<string>();
  for (const entry of Object.values(connection.offers)) {
    if (entry.kind !== "finished") continue;
    const owner = connection.participations[entry.offer.participationId]?.registration.owner;
    if (owner) scopes.add(contextScope(owner, entry.offer.id));
  }
  closeContextScopes(scopes);
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
  lifetime?: ContextOfferLifetime,
): OfferedContext {
  reapContextOffers();
  const record = realpathSync(recordDir);
  const owner = lifetime?.owner ?? readProcessOwner(process.pid);
  if (!owner || ownerPresence(owner) !== true)
    throw new ContextPreparationError("The context copy's process owner could not be verified");
  const path = mkdtempSync(
    join(realpathSync(tmpdir()), `lucid-context-offer-${contextScope(owner, lifetime?.offerId)}-`),
  );
  const within = relative(record, path);
  if (within === "" || (!within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within))) {
    removeContextCopy(path);
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
    removeContextCopy(path);
    throw new ContextPreparationError("The offered context copy could not be written", { cause });
  }
  return {
    attachmentsDir,
    path,
    text,
    close: () => removeContextCopy(path),
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
  lifetime?: ContextOfferLifetime,
): OfferedContext & { readonly attachments: readonly OfferedAttachment[] } {
  const attachments: OfferedAttachment[] = [];
  const offered = offerContext(
    recordDir,
    (attachmentsDir) => {
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
    },
    lifetime,
  );
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
  if (!isPrivateDirectory(directory) || directory.uid !== process.getuid?.())
    throw new ContextPreparationError(
      "The context directory must be a private, ordinary directory owned by this user",
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
      stat.uid !== process.getuid?.() ||
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
        recordReadProgress(canonical, offset, nextOffset);
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

const PROGRESS = "progress.json";
const PROGRESS_BYTES_MAX = 256;

/** Bytes of context text read in order from offset 0. Any doubtful progress file counts as 0. */
export function readContextProgress(path: string): number {
  let fd: number;
  try {
    const directory = lstatSync(path);
    if (!isPrivateDirectory(directory) || directory.uid !== process.getuid?.()) return 0;
    fd = openSync(join(path, PROGRESS), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return 0;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size > PROGRESS_BYTES_MAX
    )
      return 0;
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    const contiguous =
      raw !== null && typeof raw === "object" ? (raw as { contiguous?: unknown }).contiguous : null;
    return typeof contiguous === "number" && Number.isSafeInteger(contiguous) && contiguous >= 0
      ? contiguous
      : 0;
  } catch {
    return 0;
  } finally {
    closeSync(fd);
  }
}

/** A read that starts beyond the contiguous prefix is served but does not extend it. */
function recordReadProgress(path: string, offset: number, nextOffset: number): void {
  const contiguous = readContextProgress(path);
  if (offset > contiguous || nextOffset <= contiguous) return;
  try {
    atomicSidecar(join(path, PROGRESS), { contiguous: nextOffset });
  } catch {
    process.emitWarning("Offered context read progress could not be recorded", {
      code: "LUCID_CONTEXT_PROGRESS",
    });
  }
}

export type NativeContextReadIssue =
  | { readonly kind: "context-missing" }
  | { readonly kind: "context-unread"; readonly nextOffset: number };

/** Live check for a reference offer: its one copy exists, has the offered size, and was read in order. */
export function nativeContextReadIssue(
  owner: ProcessOwner,
  offerId: string,
  bytes: number,
): NativeContextReadIssue | undefined {
  const missing = { kind: "context-missing" } as const;
  let root: string;
  let names: string[];
  try {
    root = realpathSync(tmpdir());
    const prefix = `lucid-context-offer-${contextScope(owner, offerId)}-`;
    names = readdirSync(root).filter((name) => name.startsWith(prefix));
  } catch {
    return missing;
  }
  const [name] = names;
  if (names.length !== 1 || name === undefined) return missing;
  const path = join(root, name);
  try {
    const directory = lstatSync(path);
    if (!isPrivateDirectory(directory) || directory.uid !== process.getuid?.()) return missing;
    const file = lstatSync(join(path, FILE));
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 ||
      file.uid !== process.getuid?.() ||
      file.size - HEADER.length !== bytes
    )
      return missing;
    const fd = openSync(join(path, FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const header = Buffer.alloc(HEADER.length);
      if (readSync(fd, header, 0, header.length, 0) !== header.length || !header.equals(HEADER))
        return missing;
    } finally {
      closeSync(fd);
    }
  } catch {
    return missing;
  }
  const contiguous = readContextProgress(path);
  return contiguous >= bytes ? undefined : { kind: "context-unread", nextOffset: contiguous };
}
