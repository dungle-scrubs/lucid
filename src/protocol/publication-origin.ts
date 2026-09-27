import { path } from "./connection.js";
import { HARNESS_NAMES, type HarnessName, isWireId } from "./frames.js";

/** Unverified provenance the publisher declares. It grants no execution authority. */
export interface PublicationOrigin {
  readonly harness?: HarnessName;
  readonly nativeSessionId?: string;
  readonly sessionFile?: string;
}

/** null is an invalid declaration; absent fields stay absent. */
export function parsePublicationOrigin(value: unknown): PublicationOrigin | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { harness, nativeSessionId, sessionFile, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) return null;
  if (harness !== undefined && !HARNESS_NAMES.includes(harness as HarnessName)) return null;
  if (
    nativeSessionId !== undefined &&
    (typeof nativeSessionId !== "string" || !isWireId(nativeSessionId))
  )
    return null;
  if (sessionFile !== undefined && !path(sessionFile)) return null;
  return {
    ...(harness === undefined ? {} : { harness: harness as HarnessName }),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(sessionFile === undefined ? {} : { sessionFile }),
  };
}

/** The origin a creation request declared, read back from record metadata. */
export function creationOrigin(meta: Readonly<Record<string, unknown>>): PublicationOrigin | null {
  const creation = meta.creation;
  if (creation === null || typeof creation !== "object") return null;
  const request = (creation as Record<string, unknown>).request;
  if (request === null || typeof request !== "object") return null;
  const origin = (request as Record<string, unknown>).origin;
  return origin === undefined ? null : parsePublicationOrigin(origin);
}

export function originReference(origin: PublicationOrigin | null): string | null {
  if (!origin?.sessionFile) return null;
  return `This conversation began in a ${origin.harness ?? "native"} session. Its transcript is at ${origin.sessionFile}. Read it only if the note needs earlier context.`;
}
