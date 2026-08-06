/**
 * The one spelling of every `/__lucid/*` route (M1.5, D-011).
 *
 * Routes had drifted across the daemon's proxy special-cases, the CLI's
 * delivery map, and the client's fetch sites - the same route spelled three
 * ways, or a route renamed in one place and not the others. This table is the
 * single source: every site that addresses a `/__lucid/*` route imports the
 * spelling from here.
 *
 * Scope (M1.5): the CLI delivery map (`deliver.ts`) and the daemon's proxy
 * special-cases. The dispatcher table itself (route -> decoder -> handler) is
 * built on this in M3.1; the client fetch sites import it in M4.2/M4.5. Until
 * then those sites keep their own literals, swept when their milestone lands.
 *
 * `protocol/` owns the shared contract: value imports are allowed from both
 * bundles, this file imports nothing from `server/`.
 */

/** Every `/__lucid/*` route the server exposes, by stable name. */
export const LUCID_ROUTES = {
  /** CLI delivery: an agent reply line. */
  reply: "/__lucid/reply",
  /** CLI delivery: a phase/heartbeat ack. */
  ack: "/__lucid/ack",
  /** CLI delivery: the terminator of an agent turn. */
  turnEnded: "/__lucid/turn-ended",
  /** CLI delivery: a question posed to the human. */
  question: "/__lucid/question",
  /** CLI delivery / browser: end the session. */
  end: "/__lucid/end",
  /** CLI delivery: a harness session identity binding. */
  bind: "/__lucid/bind",
  /** CLI delivery: a context-usage update (sidecar fallback target). */
  context: "/__lucid/context",
  /** The viewer review page, served for the mount base (not the hub root). */
  viewer: "/__lucid/viewer",
  /** The live event stream (SSE / WebSocket upgrade). */
  events: "/__lucid/events",
  /** The session identity probe (discovery handshake). */
  identity: "/__lucid/identity",
  /** The folded session state the chrome boots from. */
  state: "/__lucid/state",
} as const;

/** Type: the union of every route name, for keyed lookups. */
export type LucidRouteName = keyof typeof LUCID_ROUTES;
