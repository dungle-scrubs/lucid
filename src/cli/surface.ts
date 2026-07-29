/**
 * Which SURFACE an `open` is for, and which URL that surface wants.
 *
 * Owns the surface vocabulary and the URL selection that follows from it
 * (plan 06, D-015). Does NOT own topology - whether a session is hub-hosted or
 * gets its own server is decided in `run.ts` and is not a surface question
 * (D-006) - and does not own process side effects; the `openBrowser` call site
 * stays with the caller. Pure in both directions: it reads an environment
 * snapshot it is handed and returns a string.
 *
 * The two surfaces:
 *
 * - `default` - a terminal harness, whose human has the shell: one window over
 *   many sessions, with a tab strip and a palette.
 * - `embedded` - a chat desktop app's browser pane, which is a window over ONE
 *   session. The chat app already plays the shell's role there, so a tab strip
 *   inside a conversation pane offers navigation the conversation already owns.
 */

export type Surface = "embedded" | "default";

/** The environment variable a harness integration exports to opt in. */
export const SURFACE_ENV = "LUCID_SURFACE";

/**
 * Read the surface from an environment snapshot.
 *
 * Never app-sniffing (D-001): a desktop app's own env vars are undocumented
 * and unstable, while this one rides the same per-harness integration file
 * that already delivers `LUCID_HARNESS`/`LUCID_SESSION_ID`/`LUCID_MODEL` -
 * variables PROVEN to reach the session log's attendant stamp intact.
 *
 * An unrecognised value is `default`, not an error: an integration file from a
 * newer Lucid naming a surface this build does not have must not break the
 * CLI, and a surface it does not have is the surface it does have.
 */
export const resolveSurface = (env: Record<string, string | undefined>): Surface =>
  env[SURFACE_ENV]?.trim().toLowerCase() === "embedded" ? "embedded" : "default";
