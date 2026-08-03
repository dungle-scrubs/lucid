import type { SessionStateCache } from "../core/log.ts";
import type { RegistryEntry } from "../core/registry.ts";
import type { SinkStatus } from "../server/observe.ts";
import type { HarnessInfo } from "./wire.ts";

/**
 * The hub tier of the wire contract: every JSON shape the hub daemon and the
 * shell exchange - the session listing, `/hub/identity`, and the open, create
 * and roots requests with their answers.
 *
 * Beside `wire.ts` rather than inside it because the two answer different
 * questions: wire.ts is ONE session's contract (its payload, its state), this
 * is the contract of the process that hosts many. The rule is the same though -
 * types only, no runtime imports, so the daemon implements these shapes and the
 * chrome bundle `import type`s them. Before this module the shell hand-mirrored
 * the daemon's own interfaces field for field, and the mirror was what actually
 * bound them: a field added on one side was a field missing on the other, and
 * nothing said so.
 */

/** A hub-listed session as the shell consumes it: the registry pointer plus
 *  its opaque mount id, its project, and whether a dedicated server is
 *  currently live. */
export interface HubSession extends RegistryEntry {
  readonly id: string;
  /** The artifact's own `<title>`, when it has one: what the shell puts on a
   *  tab. Absent for an artifact with no title (the filename stands in). */
  readonly title?: string;
  /** True when the daemon itself hosts it right now (stream + appends). */
  readonly hosted: boolean;
  /** The session's project root (nearest .git, else the artifact's own
   *  directory; a worktree resolves to its MAIN repo). A tab is a SESSION;
   *  the project is a grouping - this is what the shell groups by. */
  readonly project: string;
  /** Present when the session lives in a git worktree: that checkout's
   *  root, shown as a qualifier under its main project. */
  readonly worktree?: string;
}

/** One session's attention signals, keyed by session id, as the hub's
 *  `attention` frame carries them. The core fold's own type under the name the
 *  shell reads it by: there is one attention shape, not a hub-flavoured copy of
 *  it (src/core/attention.ts is the source). */
export type { Attention as HubAttention } from "../core/attention.ts";

/** `GET /hub/sessions` response. */
export interface HubSessionsResponse {
  readonly sessions: readonly HubSession[];
}

/** `GET /hub/identity` - who the hub is, re-read by the shell on every
 *  (re)connect: a hub restarted with `--attend`, or pointed at a new folder,
 *  would otherwise leave a live window repeating the answer it started with. */
export interface HubIdentity {
  /** The tag that says a hub answered, and not some other loopback server. */
  readonly lucid: "hub";
  readonly port: number;
  /** Connected listing subscribers, i.e. open shell windows. `lucid app` uses
   *  it to update the live window instead of stacking a new one. */
  readonly shells: number;
  /** Whether this hub spawns at all - the create affordance is pointless (and
   *  403s) on a review-only hub. */
  readonly attend: boolean;
  /** The folders being scanned, so an empty shell can say WHERE it looked. */
  readonly roots: readonly string[];
  /** The harness registry's spawn-recipe names, so the create dialog can OFFER
   *  them instead of asking for magic strings. */
  readonly harnesses: readonly string[];
  /** Each recipe's curated model/effort vocabulary. Runs PARALLEL to
   *  `harnesses` (additive): a recipe declaring neither list gets no pickers. */
  readonly harnessInfo: readonly HarnessInfo[];
  readonly defaultHarness?: string;
  /** The shared session-state fold cache's counters (M1.1 observability),
   *  readable with `curl <hub>/hub/identity`. */
  readonly debug?: { readonly sessionStateCache: ReturnType<SessionStateCache["stats"]> };
  /** The hub's OWN view of its log (M3.2): the writer is the only process that
   *  knows where its evidence actually goes. Absent from an older hub, which is
   *  why the reader falls back to deriving its own. */
  readonly log?: SinkStatus;
}

/** `POST /hub/open` - register + surface a session as a tab. */
export interface HubOpenRequest {
  readonly artifact: string;
}

/** What `POST /hub/open` answers: where the session now lives on the hub. */
export interface HubOpenResult {
  readonly ok: true;
  readonly id: string;
  readonly base: string;
  readonly shell: string;
  /** Connected shell windows at open time. 0 means nobody is looking - the
   *  CLI falls back to opening a browser. */
  readonly shells?: number;
}

/** `POST /hub/create` - mint a NEW artifact by running a spawn recipe with an
 *  author-this-artifact prompt (D3/D16). `project` must be a root the hub
 *  already scans and `name` a bare `.html` basename; the two are joined by the
 *  hub, so no request can name a path outside a project it knows. */
export interface HubCreateRequest {
  readonly project: string;
  readonly name: string;
  readonly prompt: string;
  /** The document's own name, when the human gave it one. */
  readonly title?: string;
  /** The recipe to author with; absent = the registry default. */
  readonly harness?: string;
  /** The model/effort this artifact sticks to. Absent = the CLI decides. */
  readonly model?: string;
  readonly effort?: string;
}

/** `POST /hub/create`'s 202: the turn is running. The artifact surfaces as a
 *  tab on its own `lucid open`, and the outcome arrives on the listing stream
 *  (`create-progress` / `create-failed`). */
export interface HubCreateAccepted {
  readonly ok: true;
  readonly artifact: string;
}

/** `POST /hub/roots` - add a folder to the scanned set. With no `path` the hub
 *  opens the OS folder chooser and waits on a human. */
export interface HubRootsRequest {
  readonly path?: string;
}

/** What `POST /hub/roots` answers: the folder added, the whole EFFECTIVE
 *  scanned set (not just the additions), and how many sessions that folder
 *  turned out to hold - "added" alone leaves the human wondering whether they
 *  picked the right one. The count is omitted when the scan outran its budget;
 *  the add is already persisted either way. */
export interface HubRootsResponse {
  readonly root: string;
  readonly roots: readonly string[];
  readonly found?: number;
}
