/**
 * Which VIEW an `open` is for, and which URL that view wants.
 *
 * Owns the view vocabulary and the URL selection that follows from it (plan
 * 06, D-015). Does NOT own topology - whether a session is hub-hosted or gets
 * its own server is decided in `run.ts` and is not a view question (D-006) -
 * and does not own process side effects; the `openBrowser` call site stays
 * with the caller. Pure in both directions: it reads an environment snapshot
 * it is handed and returns a string.
 *
 * "View" and not "surface", which is taken: a **surface** in Lucid is the
 * addressable rendering itself - the artifact plus the overlay that makes
 * every part of it targetable, and the core concept the whole product is built
 * on (CONTEXT.md). A **view** is the window that surface is presented IN. One
 * word, one meaning.
 *
 * The two views:
 *
 * - `shell` - a terminal harness's window over many sessions, with a tab strip
 *   and a palette. The default, and unchanged by anything here.
 * - `solo` - one session and nothing around it. What a chat desktop app's
 *   embedded browser pane shows, because the chat app already plays the role
 *   the shell plays for a terminal harness: a tab strip inside a conversation
 *   pane offers navigation the conversation already owns.
 */

import type { IdentityResponse } from "./discovery.ts";
import { soloViewerUrl, viewerUrl } from "./discovery.ts";

export type View = "solo" | "shell";

/**
 * The environment a view decision is read from.
 *
 * A declared field rather than a computed `env[VIEW_ENV]` lookup, and not only
 * for types: the harness's env-isolation scan reads `env.LUCID_X` and
 * `readonly LUCID_X` out of the source, and a computed index is the one form
 * it explicitly cannot see (`test/env-isolation.test.ts`). Written that way, a
 * variable the integration docs tell every harness to EXPORT would have been
 * invisible to the guard whose whole job is catching exactly that.
 */
export interface ViewEnv {
  readonly LUCID_VIEW?: string | undefined;
  /** Everything else a real environment carries, unread here. Present so
   *  `process.env` is assignable without a cast at the call site. */
  readonly [key: string]: string | undefined;
}

/**
 * Read the view from an environment snapshot.
 *
 * Never app-sniffing (D-001): a desktop app's own env vars are undocumented
 * and unstable, while this one rides the same per-harness integration file
 * that already delivers `LUCID_HARNESS`/`LUCID_SESSION_ID`/`LUCID_MODEL` -
 * variables PROVEN to reach the session log's attendant stamp intact.
 *
 * An unrecognised value is `shell`, not an error: an integration file from a
 * newer Lucid naming a view this build does not have must not break the CLI,
 * and a view it does not have is the view it does have.
 */
export const resolveView = (env: ViewEnv): View =>
  env.LUCID_VIEW?.trim().toLowerCase() === "solo" ? "solo" : "shell";

/**
 * The URL an `open` should return, given the view, whatever the hub already
 * answered, and the session's identity (plan 06, D-015).
 *
 * The solo branch IGNORES `hubShell` rather than falling back to it, and that
 * is the whole point of the seam. `run.ts` assigns the hub's shell URL before
 * this runs, so written as `hubShell ?? soloViewerUrl(identity)` it keeps the
 * shell URL under the solo view - handing the pane a perfectly valid URL for
 * the wrong window. It is the one line here with a silently wrong answer,
 * which is why it is a unit assertion rather than something an end-to-end run
 * has to bring a hub up to reach.
 */
export const selectOpenUrl = (args: {
  readonly view: View;
  readonly hubShell: string | undefined;
  readonly identity: IdentityResponse;
}): string =>
  args.view === "solo" ? soloViewerUrl(args.identity) : (args.hubShell ?? viewerUrl(args.identity));

/**
 * Whether a launch that WOULD open a browser window still should, given the
 * view (plan 06).
 *
 * A predicate rather than an inline conjunct because the call site is inside a
 * spawn-and-poll path: dropping the check there reds nothing, which is how the
 * first version of this shipped untested. Every launch decision the product
 * makes routes through here or through `selectOpenUrl`, so a new launcher gets
 * the behaviour rather than having to remember it.
 */
export const wantsBrowserWindow = (requested: boolean, view: View): boolean =>
  requested && view !== "solo";
