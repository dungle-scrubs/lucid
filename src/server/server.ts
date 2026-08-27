/**
 * The loopback server — one command, every record, a record chosen by URL.
 *
 * It binds 127.0.0.1 only. It mints a token when it starts, holds it in
 * memory, and requires it as a custom header on every API request. Never a
 * cookie: a cookie is attached automatically by the browser, and that is
 * the property CSRF is built on. A custom header cannot be set cross-origin
 * without a preflight, and the preflight is refused for every origin but
 * this server's own.
 *
 * The token is minted per start, so restarting invalidates every page still
 * holding the old one. Such a page gets 401, says so, and stops — it does
 * not retry against a server that will never accept it.
 *
 * **The server never drives.** It appends with `executorLease: () => false`,
 * never takes the presence lock, never opens a harness, never acts on an
 * effect. What it appends reaches the agent through whichever process does
 * hold the lease, by live delivery (RFC-04). With nothing driving, an append
 * lands and waits — the same thing `lucid2 send` does from a terminal.
 *
 * The record secret never reaches the browser. The page talks to this
 * server; this server talks to the record.
 *
 * The client is bundled from `client/` at build time and served from this
 * origin. It is never fetched from a CDN: the page holds a token that can
 * read and write every record, so running third-party script inside it
 * would hand that reach to whoever serves the script.
 *
 * Every request folds the log fresh. Nothing is cached.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { conversations } from "../cli/record-addressing.js";
import { detectAnnotationBatch } from "../protocol/annotations.js";
import { EventKind } from "../protocol/events.js";
import { TEXT_MAX } from "../protocol/frames.js";
import {
  createConversationHost,
  viewArtifactCatalog,
  viewArtifactVersion,
  viewSnapshot,
} from "../store/conversation-host.js";
import { validConversationId } from "../store/errors.js";
import { ARTIFACT_TITLE_MAX, isArtifactTitle, validArtifactId } from "../store/log.js";
import { presenceHeld } from "../store/presence.js";
// The projection is `buildView`'s, not a second one written for the
// browser. Terminal and browser disagreeing about what a conversation says
// would be a defect with no owner, so there is one derivation and both read
// it. Only `lines` is used here; the rest of `TuiView` is terminal chrome.
import { buildView } from "../tui/view.js";
import index from "./client/index.html";
import { SERVER_PORT, TOKEN_HEADER } from "./constants.js";
import { mintToken } from "./token.js";

export interface ServerOpts {
  readonly rootDir?: string;
  readonly port?: number;
  readonly token?: string;
}

export interface RunningServer {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Bytes actually on disk, against which `goodBytes` says how far the
 * fold got. A short fold means the log is damaged past that point. */
const logSize = (dir: string): number => {
  try {
    return statSync(join(dir, "log.ndjson")).size;
  } catch {
    return 0;
  }
};

/** Is the newest turn still going?
 *
 * A turn is running when the last events belong to a turn that has not
 * produced a terminal event yet. Older turns are irrelevant: one that never
 * finished because its driver was killed is history, not activity. */
const turnRunning = (transcript: {
  events: readonly { turnId: string; event: unknown }[];
}): boolean => {
  const events = transcript.events;
  const last = events[events.length - 1];
  if (last === undefined) return false;
  const turnId = last.turnId;
  for (const e of events) {
    if (e.turnId !== turnId) continue;
    if ((e.event as { kind?: string }).kind === EventKind.done) return false;
  }
  return true;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const text = (body: string, status: number): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export const startServer = async (opts: ServerOpts = {}): Promise<RunningServer> => {
  const port = opts.port ?? SERVER_PORT;
  const token = opts.token ?? mintToken();
  const rootDir = opts.rootDir;

  /** This server's own origins. A request carrying any other `Origin` is
   * refused before it is routed, which is what stops a page you happened to
   * visit from posting to a port on your own machine. A request with no
   * `Origin` is not a browser acting on another site's behalf, and it still
   * has to present the token.
   *
   * Filled in after binding, never from the requested port: `port: 0` means
   * "any free port", so the requested value is not the origin the browser
   * will send. */
  let ownOrigins = new Set<string>();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    // Never a dev server. Hot-module reloading rewrites module init order,
    // and under it assistant-ui's runtime module evaluates against a
    // half-built import and throws before the page mounts. This is a
    // product surface, so it always serves the production bundle.
    development: false,
    // Static bundle. The conversation, the artifact and the version are read
    // from the URL by the client, so every record and every artifact in it
    // share one page. The artifact segments exist so that an artifact and a
    // version are linkable at all; before them the page picked the artifact
    // with the most recent version entry and nothing else was reachable.
    routes: {
      "/c/:id": index,
      "/c/:id/:artifactId": index,
      "/c/:id/:artifactId/:version": index,
    },
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname;
      const origin = req.headers.get("origin");

      if (origin !== null && !ownOrigins.has(origin)) {
        return text("forbidden: origin not allowed", 403);
      }
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": origin ?? `http://127.0.0.1:${server.port}`,
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": `${TOKEN_HEADER}, content-type`,
            vary: "Origin",
          },
        });
      }

      // The page fetches its token here. Same exposure as serving it inside
      // the page: same-origin only, and a foreign origin is already refused
      // above.
      if (path === "/api/session" && req.method === "GET") return json({ token });

      if (path.startsWith("/api/") && req.headers.get(TOKEN_HEADER) !== token) {
        return json({ error: "unauthorized" }, 401);
      }

      if (path === "/" && req.method === "GET") {
        return json({ lucid: "browser", open: "/c/<conversationId>" });
      }

      const read = path.match(/^\/api\/conversations\/([^/]+)\/?$/);
      if (read && req.method === "GET") {
        const id = decodeURIComponent(read[1] ?? "");
        if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
        const dir = conversations(rootDir).dirFor(id);
        // An absent conversation is empty, not an error — the page is often
        // opened before anything has been said. This is checked before the
        // fold so that a missing record and a damaged one cannot arrive at
        // the same answer.
        if (!existsSync(join(dir, "log.ndjson"))) {
          return json({ conversationId: id, lines: [], status: "no record", damaged: false });
        }
        let snapshot: ReturnType<typeof viewSnapshot>;
        try {
          // Whether anything is driving comes from the presence lock, not
          // from the lease: an idle driver lets its lease lapse while
          // sitting perfectly healthy, and reading the lease alone made
          // the page say "agent-gone" while an agent was answering.
          snapshot = viewSnapshot(dir, { presence: () => presenceHeld(dir) });
        } catch (cause) {
          // The fold throws on an unparseable line rather than skipping it,
          // and `goodBytes` only ever covers a torn trailing write. Reporting
          // this as an empty conversation would render damage as silence,
          // which is the one answer a reader cannot tell from the truth.
          return json({
            conversationId: id,
            lines: [],
            status: "damaged",
            damaged: true,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
        const view = buildView({
          transcript: snapshot.transcript,
          status: snapshot.status,
          rung: "",
          draft: "",
        });
        // What is driving, so the page can say it. The harness is on the
        // attachment; the model is not always known — hcn reports it on the
        // identity event and some harnesses leave it empty — so it is sent
        // when there is one and omitted when there is not, rather than
        // shown as a blank.
        const attached = snapshot.state.attachment;
        const identity = [...snapshot.transcript.events]
          .reverse()
          .find((e) => (e.event as { kind?: string }).kind === "identity");
        const observed = ((
          identity?.event as { capabilities?: { escalation?: { observedOn?: unknown } } }
        )?.capabilities?.escalation?.observedOn ?? {}) as { model?: string; version?: string };
        // An input that carried an annotation batch keeps its place in the
        // timeline; the batch rides along on that line so the page can draw
        // the notes there rather than in a list of its own. Joined on seq,
        // which both the line and the input carry.
        const batchBySeq = new Map<number, unknown>();
        for (const i of snapshot.transcript.inputs) {
          const parsed = detectAnnotationBatch(i.text);
          if (parsed !== null && !("malformed" in parsed)) batchBySeq.set(i.seq, parsed);
        }
        const lines = view.lines.map((l) =>
          l.seq !== undefined && batchBySeq.has(l.seq) ? { ...l, batch: batchBySeq.get(l.seq) } : l,
        );

        return json({
          conversationId: id,
          lines,
          status: snapshot.status,
          // Whether anything is in flight, so the page can say so. Silence
          // and working look identical otherwise, and the question "is
          // something happening?" had no answer on the surface.
          activity: {
            // Whether the NEWEST turn has produced a terminal event.
            //
            // Not `state.turn`: that names the most recent turn so an abort
            // can target it, and its own comment says it may name a turn
            // that has already finished. Reading it as "a turn is running"
            // made the page say the agent was working for as long as the
            // record existed.
            //
            // The transcript alone is not enough. A turn appends nothing
            // between its input and its terminal event - `live1`'s log has
            // the disposition at +0.1s and then the message and `done`
            // together at +19s, with no line in between. So mid-turn the
            // newest event is the PREVIOUS turn's `done` and this reads
            // false while the agent is working. A delivered input whose
            // turn has not terminated is that turn, which is what
            // inFlightInputs counts, so it is the other half of the answer.
            turn: turnRunning(snapshot.transcript) || snapshot.state.inFlightInputs > 0,
            inFlight: snapshot.state.inFlightInputs,
            waiting: snapshot.transcript.inputs.filter(
              (i) => i.status === "outstanding" || i.status === "queued",
            ).length,
          },
          driver: {
            ...(attached?.harness === undefined ? {} : { harness: attached.harness }),
            ...(attached?.profile === undefined ? {} : { profile: attached.profile }),
            ...(typeof observed.model === "string" && observed.model !== ""
              ? { model: observed.model }
              : {}),
            ...(typeof observed.version === "string" && observed.version !== ""
              ? { harnessVersion: observed.version }
              : {}),
          },
          // A torn trailing write folds cleanly but short. That is damage
          // too, and the page says so.
          damaged: snapshot.goodBytes < logSize(dir),
        });
      }

      // Documents travel on their own channel, not with the conversation.
      // Conversation updates are small and constant; documents are large and
      // rare, so folding one into the other would make every poll pay a
      // document's size for a transcript's worth of change.
      const catalog = path.match(/^\/api\/conversations\/([^/]+)\/artifacts\/?$/);
      if (catalog && req.method === "GET") {
        const id = decodeURIComponent(catalog[1] ?? "");
        if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
        const dir = conversations(rootDir).dirFor(id);
        if (!existsSync(join(dir, "log.ndjson"))) return json({ artifacts: [], notes: {} });
        try {
          // Which spots already carry a sent note, per version. Derived from
          // the record's own inputs: an annotation batch names the artifact
          // and the version it was made against, so a mark belongs to that
          // version and to no other. Nothing is re-anchored — an id means an
          // element in the render it came from.
          const notes: Record<string, unknown[]> = {};
          try {
            for (const i of viewSnapshot(dir).transcript.inputs) {
              const batch = detectAnnotationBatch(i.text);
              if (batch === null || "malformed" in batch) continue;
              const key = `${batch.artifactId}@${batch.version}`;
              const at = notes[key] ?? [];
              notes[key] = at;
              // The notes themselves, not just which ids they touched: a
              // note made against an older version has to be re-anchored
              // here, and that needs the selectors written with it.
              for (const n of batch.notes) at.push(n);
            }
          } catch {
            // A record that will not fold has no marks to report; the
            // conversation endpoint is where that is said.
          }
          return json({ artifacts: viewArtifactCatalog(dir), notes });
        } catch {
          // A record too damaged to fold has no readable catalog. The
          // conversation endpoint is where that is reported; saying "no
          // documents" here would be a second, quieter version of the same
          // claim.
          return json({ artifacts: [], notes: {}, damaged: true });
        }
      }

      // One version per request, read by seeking to the line it lives on.
      // Nothing is held between requests.
      const version = path.match(/^\/api\/conversations\/([^/]+)\/artifacts\/([^/]+)\/(\d+)\/?$/);
      if (version && req.method === "GET") {
        const id = decodeURIComponent(version[1] ?? "");
        if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
        const artifactId = decodeURIComponent(version[2] ?? "");
        const n = Number(version[3]);
        if (!Number.isSafeInteger(n) || n < 1) return json({ error: "invalid-version" }, 400);
        const dir = conversations(rootDir).dirFor(id);
        if (!existsSync(join(dir, "log.ndjson"))) return json({ error: "no-such-version" }, 404);
        let found: ReturnType<typeof viewArtifactVersion>;
        try {
          found = viewArtifactVersion(dir, artifactId, n);
        } catch {
          return json({ error: "damaged" }, 409);
        }
        if (found === null) return json({ error: "no-such-version" }, 404);
        return json({
          artifactId: found.artifactId,
          version: found.version,
          author: found.author,
          contentType: found.contentType,
          hash: found.hash,
          at: found.at,
          bytes: found.bytes,
          // A save records what it was working from and the values of the
          // controls at the time. An agent emission has neither.
          ...(found.basedOn === undefined ? {} : { basedOn: found.basedOn }),
          ...(found.values === undefined ? {} : { values: found.values }),
        });
      }

      // A save is an artifact version entry. It is NOT an input: it starts
      // no turn, is not counted against the input bound, and carries no
      // disposition. It records what is true and waits to be read — through
      // live delivery, or the next time anything folds the record.
      const save = path.match(/^\/api\/conversations\/([^/]+)\/artifacts\/([^/]+)\/save\/?$/);
      if (save && req.method === "POST") {
        const id = decodeURIComponent(save[1] ?? "");
        if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
        const artifactId = decodeURIComponent(save[2] ?? "");
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "invalid-json" }, 400);
        }
        const b = body as { html?: unknown; values?: unknown; basedOn?: unknown };
        if (typeof b.html !== "string" || b.html.trim() === "") {
          return json({ error: "html-required" }, 400);
        }
        if (typeof b.basedOn !== "number" || !Number.isSafeInteger(b.basedOn) || b.basedOn < 1) {
          return json({ error: "based-on-required" }, 400);
        }
        const values: Record<string, string> = {};
        if (b.values !== null && typeof b.values === "object" && !Array.isArray(b.values)) {
          for (const [k, v] of Object.entries(b.values as Record<string, unknown>)) {
            if (typeof v === "string") values[k] = v;
          }
        }
        const dir = conversations(rootDir).dirFor(id);
        if (!existsSync(join(dir, "log.ndjson"))) return json({ error: "no-such-record" }, 404);
        const host = createConversationHost(dir, {
          now: () => Date.now(),
          presence: () => undefined,
          executorLease: () => false,
          onEffect: () => {},
          onRecord: () => {},
        });
        try {
          // The next version in the single ordered list. There is no
          // branching: a save based on a version the agent has since
          // replaced still appends at the end, recording what it was
          // working from. The agent reconciles; lucid does not merge.
          let current = 0;
          for (const key of host.artifactIndex().keys()) {
            const sep = key.indexOf("\0");
            if (sep === -1 || key.slice(0, sep) !== artifactId) continue;
            const v = Number(key.slice(sep + 1));
            if (Number.isSafeInteger(v) && v > current) current = v;
          }
          if (current === 0) return json({ error: "no-such-artifact" }, 404);
          const result = host.writeArtifact({
            artifactId,
            version: current + 1,
            author: "human",
            contentType: "text/html",
            bytes: b.html,
            basedOn: b.basedOn,
            values,
          });
          if (result.verdict === "refused") {
            // Refused, and what was typed is still in the page — nothing
            // here clears it.
            return json(
              { error: result.issue, verdict: "refused" },
              result.issue === "artifact-too-large" ? 413 : 409,
            );
          }
          return json({
            verdict: "accepted",
            artifactId,
            version: result.version.version,
            basedOn: b.basedOn,
            supersededSince: b.basedOn !== current,
          });
        } finally {
          host.close();
        }
      }

      // Restore is a person's act on the record, and it is an append like any
      // other. lucid copies the bytes of the version being restored into a new
      // version at the end of the list. Nothing is removed, rewritten or
      // hidden - the version it replaced is still there and still reachable,
      // which is what makes undoing a restore the same act again.
      const meta = path.match(/^\/api\/conversations\/([^/]+)\/artifacts\/([^/]+)\/meta\/?$/);
      if (meta && req.method === "POST") {
        const id = decodeURIComponent(meta[1] ?? "");
        if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
        const artifactId = decodeURIComponent(meta[2] ?? "");
        if (!validArtifactId(artifactId)) return json({ error: "unknown-artifact" }, 404);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "invalid-json" }, 400);
        }
        const b = body as { title?: unknown };
        // E-ART-07. The bound is checked here, where a caller can be told,
        // rather than left to the fold, which would silently drop the field.
        if (!isArtifactTitle(b.title)) {
          return json({ error: "invalid-title", max: ARTIFACT_TITLE_MAX }, 400);
        }
        const dir = conversations(rootDir).dirFor(id);
        if (!existsSync(join(dir, "log.ndjson"))) return json({ error: "no-such-record" }, 404);
        const host = createConversationHost(dir, {
          now: () => Date.now(),
          presence: () => undefined,
          executorLease: () => false,
          onEffect: () => {},
          onRecord: () => {},
        });
        try {
          // E-ART-01. Naming an artifact the record does not hold is refused
          // here, because this is the only place that can answer a caller.
          // The fold tolerates such an entry anyway, so a record written by
          // a build whose endpoint had a defect still opens.
          let held = false;
          for (const key of host.artifactIndex().keys()) {
            const sep = key.indexOf("\0");
            if (sep !== -1 && key.slice(0, sep) === artifactId) {
              held = true;
              break;
            }
          }
          if (!held) return json({ error: "unknown-artifact" }, 404);
          const result = host.writeArtifactMeta({ artifactId, title: b.title });
          if (result.verdict === "refused") {
            return json({ error: result.issue, verdict: "refused" }, 400);
          }
          return json({ artifactId, title: b.title });
        } finally {
          host.close();
        }
      }

      const restore = path.match(/^\/api\/conversations\/([^/]+)\/artifacts\/([^/]+)\/restore\/?$/);
      if (restore && req.method === "POST") {
        const id = decodeURIComponent(restore[1] ?? "");
        if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
        const artifactId = decodeURIComponent(restore[2] ?? "");
        if (!validArtifactId(artifactId)) return json({ error: "unknown-artifact" }, 404);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "invalid-json" }, 400);
        }
        const b = body as { version?: unknown };
        if (typeof b.version !== "number" || !Number.isSafeInteger(b.version) || b.version < 1) {
          return json({ error: "version-required" }, 400);
        }
        const dir = conversations(rootDir).dirFor(id);
        if (!existsSync(join(dir, "log.ndjson"))) return json({ error: "no-such-record" }, 404);
        const host = createConversationHost(dir, {
          now: () => Date.now(),
          presence: () => undefined,
          executorLease: () => false,
          onEffect: () => {},
          onRecord: () => {},
        });
        try {
          let current = 0;
          for (const key of host.artifactIndex().keys()) {
            const sep = key.indexOf("\0");
            if (sep === -1 || key.slice(0, sep) !== artifactId) continue;
            const v = Number(key.slice(sep + 1));
            if (Number.isSafeInteger(v) && v > current) current = v;
          }
          if (current === 0) return json({ error: "unknown-artifact" }, 404);
          // Restoring what is already current would append a copy that
          // records nothing.
          if (b.version === current) return json({ error: "restore-of-current" }, 409);
          const from = host.readArtifact(artifactId, b.version);
          if (from === null) return json({ error: "version-unreadable" }, 404);
          const result = host.writeArtifact({
            artifactId,
            version: current + 1,
            author: "human",
            contentType: from.contentType,
            bytes: from.bytes,
            basedOn: b.version,
            // The values the restored version carried, if it carried any.
            // Restoring a state means restoring the controls too.
            ...(from.values === undefined ? {} : { values: from.values }),
          });
          if (result.verdict === "refused") {
            return json(
              { error: result.issue, verdict: "refused" },
              result.issue === "artifact-too-large" ? 413 : 409,
            );
          }
          return json({
            verdict: "accepted",
            artifactId,
            version: result.version.version,
            restoredFrom: b.version,
            replaced: current,
          });
        } finally {
          host.close();
        }
      }

      const write = path.match(/^\/api\/conversations\/([^/]+)\/input\/?$/);
      if (write && req.method === "POST") {
        const id = decodeURIComponent(write[1] ?? "");
        if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "invalid-json" }, 400);
        }
        const value = (body as { text?: unknown }).text;
        if (typeof value !== "string" || value.trim() === "") {
          return json({ error: "text-required" }, 400);
        }
        // The protocol's own bound, imported rather than restated. A limit
        // mirrored here would drift from the one that actually refuses.
        if (value.length > TEXT_MAX) return json({ error: "text-too-large" }, 413);

        const { dir } = conversations(rootDir).ensure(id);
        const host = createConversationHost(dir, {
          now: () => Date.now(),
          presence: () => undefined,
          executorLease: () => false,
          onEffect: () => {},
          onRecord: () => {},
        });
        try {
          const inputId = `browser-${randomUUID()}`;
          const result = host.enqueueInput({ id: inputId, text: value, mode: "queue" });
          if (result.verdict === "refused") {
            return json(
              { error: result.issue, verdict: "refused" },
              result.issue === "input-queue-full" ? 429 : 400,
            );
          }
          return json({ inputId, verdict: "accepted" });
        } finally {
          host.close();
        }
      }

      return text("not found", 404);
    },
  });

  // `port: 0` is how a test asks the kernel for a free port, so the bound
  // port is read back from the server rather than echoed from the request.
  const bound = server.port ?? port;
  ownOrigins = new Set([`http://127.0.0.1:${bound}`, `http://localhost:${bound}`]);
  return {
    port: bound,
    token,
    url: `http://127.0.0.1:${bound}`,
    close: async () => {
      await server.stop(true);
    },
  };
};
