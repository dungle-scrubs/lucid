/**
 * What the address bar names.
 *
 * It named a conversation and nothing else, so an artifact was picked as
 * "the last one in the catalog" and nothing about one was linkable. A record
 * holding two artifacts had one of them unreachable.
 *
 * Now the path carries the artifact, and optionally the version, and the page
 * keeps it in step with what is on screen.
 */

export interface Route {
  readonly conversationId: string;
  /** Absent means: show the artifact with the most recent version entry,
   * which is what the page did before there was anything else to say. */
  readonly artifactId?: string;
  /** Absent means follow the newest version. */
  readonly version?: number;
}

/**
 * An `artifactId` is percent-encoded in a path segment and decoded out of
 * one. It is NOT checked against the conversation id's path-safe alphabet:
 * an artifact id is an index key, not a directory name, and the narrower
 * rule would make artifacts the record already holds unreachable. The store
 * exports `validArtifactId`, which is the rule the fold itself applies, and
 * that is what the server checks a decoded value against.
 */
const decodeSegment = (raw: string): string | null => {
  try {
    const out = decodeURIComponent(raw);
    return out === "" ? null : out;
  } catch {
    // A malformed escape. Not an id, and not worth guessing at.
    return null;
  }
};

/** Read a path. Anything it cannot make sense of is left absent, so the page
 * falls back to what it did before rather than refusing to render. */
export const parseRoute = (pathname: string): Route | null => {
  const parts = pathname.replace(/\/+$/, "").split("/");
  // ["", "c", conversation, artifact?, version?]
  if (parts.length < 3 || parts[1] !== "c") return null;
  const conversationId = decodeSegment(parts[2] ?? "");
  if (conversationId === null) return null;

  const artifactId = parts.length > 3 ? decodeSegment(parts[3] ?? "") : null;
  if (artifactId === null) return { conversationId };

  if (parts.length <= 4) return { conversationId, artifactId };

  const version = Number.parseInt(parts[4] ?? "", 10);
  // A version is a positive integer or it is nothing. Trailing junk in the
  // segment is not a version either, which parseInt alone would accept.
  return Number.isSafeInteger(version) && version >= 1 && String(version) === parts[4]
    ? { conversationId, artifactId, version }
    : { conversationId, artifactId };
};

/** Write a path. The inverse of `parseRoute` for every route it can produce. */
export const formatRoute = (route: Route): string => {
  const base = `/c/${encodeURIComponent(route.conversationId)}`;
  if (route.artifactId === undefined) return base;
  const withArtifact = `${base}/${encodeURIComponent(route.artifactId)}`;
  return route.version === undefined ? withArtifact : `${withArtifact}/${route.version}`;
};

/** Whether the address already names this, so the page does not push a
 * history entry saying what the bar already says. */
export const sameRoute = (a: Route | null, b: Route | null): boolean =>
  a?.conversationId === b?.conversationId &&
  a?.artifactId === b?.artifactId &&
  a?.version === b?.version;
