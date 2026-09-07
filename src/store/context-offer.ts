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
import type { ProcessOwner } from "../protocol/process-owner.js";
import { hashBlob } from "./blobs.js";
import { ContextPreparationError } from "./conversation-context.js";

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

export function offerContext(
  recordDir: string,
  content: string,
): { readonly attachmentsDir: string; readonly path: string; close(): void } {
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
  try {
    writeFileSync(join(path, FILE), Buffer.concat([HEADER, Buffer.from(content)]), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (cause) {
    rmSync(path, { recursive: true, force: true });
    throw new ContextPreparationError("The offered context copy could not be written", { cause });
  }
  return {
    attachmentsDir: join(path, "attachments"),
    path,
    close: () => rmSync(path, { recursive: true, force: true }),
  };
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
