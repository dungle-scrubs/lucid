/**
 * The one spelling of every `/__lucid/*` route (M1.5, D-011).
 *
 * Routes had drifted across the daemon's proxy special-cases, the CLI's
 * delivery map, and the client's fetch sites - the same route spelled three
 * ways, or a route renamed in one place and not the others. This table is the
 * single source: every site that addresses a `/__lucid/*` route imports the
 * spelling from here.
 *
 * Scope: the CLI delivery map (`deliver.ts`), the daemon's proxy
 * special-cases, and the route->decoder dispatcher table (`inbound.ts`'s
 * `APPEND_ROUTE_DECODERS`, M2.1) all read their spellings from here. The
 * browser POST routes the dispatcher covers (annotation/fork/message/revert/
 * rename/question/answer) live here too. Client fetch sites still keep their
 * own literals, swept when the inbound surface seam (M2.4) lands.
 *
 * `protocol/` owns the shared contract: value imports are allowed from both
 * bundles, this file imports nothing from `server/`.
 */

/** Every `/__lucid/*` route the server exposes, by stable name. */
export const LUCID_ROUTES = {
  /** Browser POST: a human annotation on the artifact. */
  annotation: "/__lucid/annotation",
  /** Browser POST: a fork request for a new artifact. */
  fork: "/__lucid/fork",
  /** Browser POST: a human chat message. */
  message: "/__lucid/message",
  /** Browser POST: a revert to a prior version. */
  revert: "/__lucid/revert",
  /** Browser POST: rename the artifact's title. */
  rename: "/__lucid/rename",
  /** A question posed to the human (browser POST, relayed by CLI delivery). */
  question: "/__lucid/question",
  /** Browser POST: the human's answer to a question. */
  answer: "/__lucid/answer",
  /** CLI delivery: an agent reply line. */
  reply: "/__lucid/reply",
  /** CLI delivery: a phase/heartbeat ack. */
  ack: "/__lucid/ack",
  /** CLI delivery: the terminator of an agent turn. */
  turnEnded: "/__lucid/turn-ended",
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
