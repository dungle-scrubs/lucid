import { ConfigurationError } from "../config/user-config.js";
import { comparisonMetadata } from "../protocol/comparison-note.js";
import {
  fallbackConversationTitle,
  storedConversationTitle,
  titleState,
} from "../protocol/conversation-title.js";
import { HubError } from "../protocol/hub-errors.js";
import { renameConversation } from "../store/conversation-naming.js";
import { readRecordMetadata } from "../store/record-identity.js";

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
 * lands and waits — the same thing `lucid send` does from a terminal.
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
import { assertServerProcess } from "../cli/invocation.js";
import { conversations } from "../cli/record-addressing.js";
import { ownerPresence, terminalPresence } from "../process-owner.js";
import { detectAnnotationBatch } from "../protocol/annotations.js";
import { isTextBytes, sniffImageType, withinAttachmentBound } from "../protocol/attachment.js";
import { EventKind } from "../protocol/events.js";
import { executionViews } from "../protocol/execution-view.js";
import { isWireId, TEXT_MAX } from "../protocol/frames.js";
import { getBlob } from "../store/blobs.js";
import {
  type ConversationHost,
  openWriter,
  viewArtifactCatalog,
  viewArtifactVersion,
  viewSnapshot,
} from "../store/conversation-host.js";
import { CreationError } from "../store/creation.js";
import { RecordLookupError, watchConversations } from "../store/discovery.js";
import { readDriverPreference } from "../store/driver-preference.js";
import { classifyStoreFailure, validConversationId } from "../store/errors.js";
import {
  ARTIFACT_TITLE_MAX,
  isArtifactField,
  isArtifactTitle,
  validArtifactId,
} from "../store/log.js";
import { presenceHeld } from "../store/presence.js";
import { WorkingFolderError } from "../store/project-directory.js";
import { preferenceState, replaceLocation } from "../store/settings.js";
// The projection is `buildView`'s, not a second one written for the
// browser. Terminal and browser disagreeing about what a conversation says
// would be a defect with no owner, so there is one derivation and both read
// it. Only `lines` is used here; the rest of `TuiView` is terminal chrome.
import { buildView } from "../tui/view.js";
import hub from "./client/hub.html";
import index from "./client/index.html";
import { SERVER_PORT, TOKEN_HEADER } from "./constants.js";
import { createConversationListing } from "./conversation-list.js";
import { createFolderPicker } from "./folder-picker.js";
import { createHubSettings } from "./hub-settings.js";
import type { ManagedLaunch } from "./managed-launch.js";
import { createManagedLaunchReconciler } from "./managed-launch.js";
import { recoveryStamp } from "./recovery-availability.js";
import { mintToken } from "./token.js";

export interface ServerOpts {
  readonly harnessStartup?: Promise<import("../harness/node-deps.js").HarnessStartup>;
  readonly chooseFolder?: (signal: AbortSignal) => Promise<string | null>;
  readonly managedLaunch?: ManagedLaunch;
  readonly reconcileMs?: number;
  readonly configLocation?: import("../config/user-config.js").ConfigLocation;
  readonly wakeNaming?: (root: string) => void;
  readonly runner?: import("../harness/runner.js").HarnessRunner;
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
const turnRunning = (
  transcript: {
    events: readonly { epoch: number; turnId: string; event: unknown }[];
  },
  epoch: number,
): boolean => {
  const events = transcript.events.filter(
    (event) => event.epoch === epoch && (event.event as { code?: string }).code !== "E-COMP-07",
  );
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

const withWriter = async (
  dir: string,
  conversationId: string,
  action: (host: ConversationHost) => Response | Promise<Response>,
): Promise<Response> => {
  let host: ConversationHost | undefined;
  try {
    host = openWriter(dir, { expectedConversationId: conversationId });
    return await action(host);
  } catch (cause) {
    const code = classifyStoreFailure(cause);
    if (code === "record-busy") {
      const response = json({ error: "record-busy" }, 503);
      response.headers.set("retry-after", "1");
      return response;
    }
    if (code === "record-unreadable") return json({ error: "damaged" }, 409);
    throw cause;
  } finally {
    host?.close();
  }
};

const hubFailure = (error: unknown): Response => {
  if (error instanceof RecordLookupError) throw error;
  if (error instanceof WorkingFolderError)
    return json(
      { error: "E-HUB-04", reason: error.message, actions: ["Choose a working folder"] },
      400,
    );
  if (error instanceof HubError)
    return json({ error: error.code, reason: error.message, actions: error.actions }, error.status);
  if (error instanceof CreationError)
    return json(
      {
        error: error.code,
        reason: error.message,
        actions: [error.status === 503 ? "Retry the same request" : "Review creation request"],
      },
      error.status,
    );
  return json(
    {
      error: "E-HUB-03",
      reason: error instanceof Error ? error.message : "Settings unavailable",
      actions: [
        error instanceof ConfigurationError ? "Correct the user configuration" : "Review settings",
      ],
    },
    400,
  );
};

export const startServer = async (opts: ServerOpts = {}): Promise<RunningServer> => {
  assertServerProcess();
  const port = opts.port ?? SERVER_PORT;
  const folderPicker = createFolderPicker(opts.chooseFolder, opts.chooseFolder ? true : undefined);
  const token = opts.token ?? mintToken();
  const records = conversations(opts.rootDir, opts.configLocation);
  const conversationPage = createConversationListing();
  const rootDir = records.rootDir;
  const settings = createHubSettings(
    rootDir,
    opts.configLocation,
    opts.runner,
    opts.rootDir !== undefined || process.env.LUCID_ROOT !== undefined,
    records.discoveryIndex,
    opts.harnessStartup,
  );
  const wakeNaming = (): void => {
    try {
      opts.wakeNaming?.(rootDir);
    } catch {}
  };
  const launchReconciler = opts.managedLaunch
    ? createManagedLaunchReconciler(rootDir, opts.managedLaunch)
    : undefined;
  const requestManaged = (conversationId: string, inputId: string): void => {
    setTimeout(() => {
      try {
        opts.managedLaunch?.request(rootDir, conversationId, inputId);
      } catch {}
    }, 0);
  };
  const reconcileManaged = (): void => {
    if (!launchReconciler) return;
    const found = discovery.current();
    if (!(found instanceof RecordLookupError)) launchReconciler(found);
  };

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
      "/": hub,
      "/c/:id": index,
      "/c/:id/:artifactId": index,
      "/c/:id/:artifactId/:version": index,
    },
    fetch: async (req: Request): Promise<Response> => {
      try {
        const url = new URL(req.url);
        const path = url.pathname;
        let resolvedRecord: string | undefined;
        const dirForRequest = (id: string): string => (resolvedRecord ??= records.dirFor(id));
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

        // A URL bar, a history entry, or a pasted link carries a trailing
        // slash as often as not, and Bun's route table above matches exact
        // paths only - "/c/demo/" would fall through to the 404 at the foot
        // of this handler. Send the canonical path back and let the browser
        // re-ask: the page route answers it, and the address bar ends up on
        // the form that reloads cleanly.
        if (path.length > 1 && path.endsWith("/")) {
          return new Response(null, {
            status: 308,
            headers: { location: path.replace(/\/+$/, "") + url.search },
          });
        }

        if (path === "/api/defaults" && req.method === "GET") {
          try {
            return json({
              ...(await settings.defaults()),
              folderPickerAvailable: folderPicker.available,
            });
          } catch (error) {
            return hubFailure(error);
          }
        }
        if (path === "/api/folder-picker" && req.method === "POST") {
          server.timeout(req, 0);
          try {
            return json(await folderPicker.select(req.signal));
          } catch (error) {
            return hubFailure(error);
          }
        }
        if (path === "/api/conversations" && req.method === "POST") {
          try {
            return json(await settings.create(await req.json()), 201);
          } catch (error) {
            return hubFailure(error);
          }
        }
        if (path === "/api/conversations" && req.method === "GET") {
          try {
            const listing = discovery.refresh();
            if (listing instanceof RecordLookupError) throw listing;
            const page = await conversationPage(listing, url.searchParams);
            return json(page, "error" in page ? 400 : 200);
          } catch (cause) {
            if (cause instanceof RecordLookupError)
              return json(
                {
                  ...(cause.reason === "not-found" ? {} : { code: "E-HUB-01" }),
                  error: cause.reason,
                  reason:
                    cause.reason === "not-found"
                      ? "This conversation is not in the configured record folder. Open the hub to choose an existing conversation."
                      : cause.reason === "ambiguous"
                        ? "More than one record has this conversation identity. Resolve the duplicate records before opening it."
                        : "The configured record folder is unavailable. Check its location and access, then refresh.",
                  actions:
                    cause.reason === "not-found"
                      ? ["open-hub"]
                      : cause.reason === "ambiguous"
                        ? ["resolve-duplicate-records", "refresh"]
                        : ["check-record-folder", "refresh"],
                },
                503,
              );
            throw cause;
          }
        }

        const recordRoute = path.match(/^\/api\/conversations\/([^/]+)/);
        if (recordRoute) {
          let id: string;
          try {
            id = decodeURIComponent(recordRoute[1] ?? "");
          } catch {
            return json({ error: "invalid-conversation-id" }, 400);
          }
          if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
          dirForRequest(id);
        }

        const titleWrite = path.match(/^\/api\/conversations\/([^/]+)\/title\/?$/);
        if (titleWrite && req.method === "POST") {
          const id = decodeURIComponent(titleWrite[1] ?? "");
          try {
            const body: unknown = await req.json();
            if (!body || typeof body !== "object" || Array.isArray(body))
              throw new HubError("Expected a title and title revision.", "E-HUB-08", 400, [
                "Edit title",
              ]);
            const request = body as Record<string, unknown>;
            return json(
              renameConversation(dirForRequest(id), id, request.expectedRevision, request.title),
            );
          } catch (error) {
            if (error instanceof SyntaxError)
              return hubFailure(
                new HubError(
                  "Expected valid JSON with a title and title revision.",
                  "E-HUB-08",
                  400,
                  ["Edit title"],
                ),
              );
            if (error instanceof HubError || error instanceof RecordLookupError)
              return hubFailure(error);
            return json(
              {
                error: "E-HUB-01",
                reason: "Cannot update the conversation record.",
                actions: ["Check record folder", "Retry rename"],
              },
              503,
            );
          }
        }

        const recovery = path.match(/^\/api\/conversations\/([^/]+)\/inputs\/([^/]+)\/recovery$/);
        if (recovery && req.method === "POST") {
          const id = decodeURIComponent(recovery[1] ?? "");
          const inputId = decodeURIComponent(recovery[2] ?? "");
          if (!validConversationId(id) || !isWireId(inputId))
            return json({ error: "E-HUB-02", reason: "Invalid recovery identity." }, 400);
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return json({ error: "invalid-json" }, 400);
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            return json({ error: "E-HUB-02" }, 400);
          const value = body as Record<string, unknown>;
          if (
            (value.action !== "retry" && value.action !== "continue-fresh") ||
            typeof value.actionId !== "string" ||
            !isWireId(value.actionId) ||
            !Number.isSafeInteger(value.expectedAttempt) ||
            typeof value.acknowledgeEffects !== "boolean"
          )
            return json(
              {
                error: "E-HUB-02",
                reason:
                  "Recovery requires an action ID, expected attempt, and effects acknowledgement.",
              },
              400,
            );
          return await withWriter(dirForRequest(id), id, async (host) => {
            const state = host.state();
            const prior = state.executions[inputId];
            const duplicate = prior && Object.hasOwn(prior.actions, String(value.actionId));
            const stamp = recoveryStamp(host.dir, state);
            if (
              !duplicate &&
              !(await settings.recovery(host.dir, state)).actions.includes(
                value.action as "retry" | "continue-fresh",
              )
            )
              return json(
                {
                  error: "E-HUB-03",
                  reason:
                    "This route cannot perform that recovery. Check the working folder and settings.",
                },
                409,
              );
            const result = host.writeExecution(
              {
                kind: value.action === "retry" ? "retry-authorized" : "fresh-authorized",
                inputId,
                attempt: value.expectedAttempt,
                actionId: value.actionId,
                acknowledgeEffects: value.acknowledgeEffects,
              },
              () => duplicate === true || recoveryStamp(host.dir, host.state()) === stamp,
            );
            if (result.verdict === "refused")
              return json(
                {
                  error: "E-HUB-02",
                  reason: "This action is stale or no longer available. Refresh the conversation.",
                  issue: result.issue,
                },
                409,
              );
            requestManaged(id, inputId);
            return json({ verdict: "accepted", inputId, actionId: value.actionId });
          });
        }

        const read = path.match(/^\/api\/conversations\/([^/]+)\/?$/);
        if (read && req.method === "GET") {
          const id = decodeURIComponent(read[1] ?? "");
          if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
          const dir = dirForRequest(id);
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
              compatibility: settings.compatibility(),
              status: "damaged",
              damaged: true,
              error: cause instanceof Error ? cause.message : String(cause),
              driverPreference: readDriverPreference(dir),
              driverChoices: await settings.choices(),
            });
          }
          const titleMeta = readRecordMetadata(dir);
          const title =
            storedConversationTitle(
              typeof titleMeta.conversationTitle === "string"
                ? titleMeta.conversationTitle
                : undefined,
            ) ?? fallbackConversationTitle(snapshot.transcript.inputs);
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
          const driving = attached !== null && snapshot.status !== "agent-gone";
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
            if (parsed !== null && !("malformed" in parsed)) {
              const metadata = comparisonMetadata(i.text);
              const hold =
                i.status === "outstanding" || i.status === "queued"
                  ? [...snapshot.transcript.events]
                      .reverse()
                      .find(
                        (event) => event.event.code === "E-COMP-07" && event.event.inputId === i.id,
                      )?.event.message
                  : undefined;
              batchBySeq.set(i.seq, {
                ...parsed,
                inputId: i.id,
                status: i.status,
                comparisonUsable: metadata.kind === "comparison",
                ...(typeof hold === "string" ? { hold } : {}),
              });
            }
          }
          const lines = view.lines.map((l) =>
            l.seq !== undefined && batchBySeq.has(l.seq)
              ? { ...l, batch: batchBySeq.get(l.seq) }
              : l,
          );

          let executions = executionViews(
            snapshot.state,
            driving,
            terminalPresence(snapshot.state.terminalParticipations, (owner) =>
              owner ? ownerPresence(owner) : undefined,
            ) ?? null,
          ).filter((entry) => entry.status !== "completed");
          if (executions.some((entry) => entry.actions.length > 0)) {
            const available = await settings.recovery(dir, snapshot.state);
            executions = executions.map((entry) => ({
              ...entry,
              actions: entry.actions.filter((action) => available.actions.includes(action)),
              reason:
                entry.actions.length > 0 && available.reason
                  ? `${entry.reason} ${available.reason}`
                  : entry.reason,
            }));
          }
          return json({
            conversationId: id,
            lines,
            status: snapshot.status,
            // Whether anything is in flight, so the page can say so. Silence
            // and working look identical otherwise, and the question "is
            // something happening?" had no answer on the surface.
            executions,
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
              // An old session error is history after detach or process loss.
              // Only the current attachment can have work in progress.
              turn:
                driving &&
                (turnRunning(snapshot.transcript, snapshot.state.epoch) ||
                  snapshot.state.inFlightInputs > 0),
              inFlight: driving ? snapshot.state.inFlightInputs : 0,
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
            // What the person chose, beside what is driving (RFC-12). The two
            // are never one field: after a refused re-spawn they differ, and
            // the difference is the story the page has to tell. Null is the
            // state of every record no choice has been made in.
            ...(await settings.project(
              dir,
              {
                ...(attached?.harness ? { harness: attached.harness } : {}),
                ...(attached?.profile ? { profile: attached.profile } : {}),
                ...(typeof observed.model === "string" ? { model: observed.model } : {}),
              },
              snapshot.state.harnessSessions,
            )),
            // The lists the choice is made from (RFC-12): the four harnesses,
            // each harness's models and efforts. Read once per process through
            // the harness seam, so a poll costs no spawn.
            driverChoices: await settings.choices(),
            // A torn trailing write folds cleanly but short. That is damage
            // too, and the page says so.
            title,
            ...titleState(titleMeta),
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
          const dir = dirForRequest(id);
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
          const dir = dirForRequest(id);
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
          const dir = dirForRequest(id);
          if (!existsSync(join(dir, "log.ndjson"))) return json({ error: "no-such-record" }, 404);
          const { html, basedOn } = b;
          return withWriter(dir, id, (host) => {
            // The next version in the single ordered list. There is no
            // branching: a save based on a version the agent has since
            // replaced still appends at the end, recording what it was
            // working from. The agent reconciles; lucid does not merge.
            const current = host.artifactHeads().get(artifactId) ?? 0;
            if (current === 0) return json({ error: "no-such-artifact" }, 404);
            const result = host.writeArtifact({
              artifactId,
              version: current + 1,
              author: "human",
              contentType: "text/html",
              bytes: html,
              basedOn: basedOn,
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
              basedOn: basedOn,
              supersededSince: basedOn !== current,
            });
          });
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
          if (b.title !== undefined && !isArtifactTitle(b.title)) {
            return json({ error: "invalid-title", max: ARTIFACT_TITLE_MAX }, 400);
          }
          // A request that says nothing is a mistake worth reporting rather
          // than an append of an entry with no opinion in it.
          if (b.title === undefined) {
            return json({ error: "nothing-to-write" }, 400);
          }
          const dir = dirForRequest(id);
          if (!existsSync(join(dir, "log.ndjson"))) return json({ error: "no-such-record" }, 404);
          const { title } = b;
          return withWriter(dir, id, (host) => {
            // E-ART-01. Naming an artifact the record does not hold is refused
            // here, because this is the only place that can answer a caller.
            // The fold tolerates such an entry anyway, so a record written by
            // a build whose endpoint had a defect still opens.
            if (!host.artifactHeads().has(artifactId))
              return json({ error: "unknown-artifact" }, 404);
            const result = host.writeArtifactMeta({
              artifactId,
              ...(title === undefined ? {} : { title: title }),
            });
            if (result.verdict === "refused") {
              return json({ error: result.issue, verdict: "refused" }, 400);
            }
            return json({
              artifactId,
              ...(title === undefined ? {} : { title: title }),
            });
          });
        }

        const restore = path.match(
          /^\/api\/conversations\/([^/]+)\/artifacts\/([^/]+)\/restore\/?$/,
        );
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
          const dir = dirForRequest(id);
          if (!existsSync(join(dir, "log.ndjson"))) return json({ error: "no-such-record" }, 404);
          const { version } = b;
          return withWriter(dir, id, (host) => {
            const current = host.artifactHeads().get(artifactId) ?? 0;
            if (current === 0) return json({ error: "unknown-artifact" }, 404);
            // Restoring what is already current would append a copy that
            // records nothing.
            if (version === current) return json({ error: "restore-of-current" }, 409);
            const from = host.readArtifact(artifactId, version);
            if (from === null) return json({ error: "version-unreadable" }, 404);
            const result = host.writeArtifact({
              artifactId,
              version: current + 1,
              author: "human",
              contentType: from.contentType,
              bytes: from.bytes,
              basedOn: version,
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
              restoredFrom: version,
              replaced: current,
            });
          });
        }

        const locationRoute = path.match(/^\/api\/conversations\/([^/]+)\/location\/?$/);
        if (locationRoute && req.method === "POST") {
          const id = decodeURIComponent(locationRoute[1] ?? "");
          try {
            const body = await req.json();
            if (
              typeof body.workingDirectory !== "string" ||
              !body.workingDirectory.startsWith("/") ||
              !Number.isSafeInteger(body.expectedRevision) ||
              body.expectedRevision < 0
            )
              throw new HubError(
                "Choose an absolute working folder and supply its revision.",
                "E-HUB-04",
                400,
                ["Choose a working folder"],
              );
            return json(
              replaceLocation(dirForRequest(id), id, body.expectedRevision, body.workingDirectory),
            );
          } catch (error) {
            return hubFailure(error);
          }
        }
        const driverPref = path.match(/^\/api\/conversations\/([^/]+)\/driver\/?$/);
        if (driverPref && req.method === "POST") {
          const id = decodeURIComponent(driverPref[1] ?? "");
          try {
            const updated = await settings.update(dirForRequest(id), id, await req.json());
            wakeNaming();
            return json(updated);
          } catch (error) {
            return hubFailure(error);
          }
        }

        const write = path.match(/^\/api\/conversations\/([^/]+)\/input\/?$/);
        // Read an attachment back, for a thumbnail (RFC-11).
        //
        // This is the BROWSER surface, and it is where the hex guard belongs:
        // the name is resolved as a sha256 hex string before anything touches
        // the filesystem, so `../secret` fails on the shape of the name. The
        // agent surface is a different problem with a different answer - see
        // the offered path in `src/store/deliver.ts`.
        const blob = path.match(/^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)\/?$/);
        if (blob && req.method === "GET") {
          const id = decodeURIComponent(blob[1] ?? "");
          if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
          const hash = decodeURIComponent(blob[2] ?? "");
          if (!/^[0-9a-f]{64}$/.test(hash)) return json({ error: "not-an-attachment" }, 400);
          const dir = dirForRequest(id);
          let bytes: Uint8Array | null = null;
          try {
            bytes = getBlob(dir, hash);
          } catch {
            return json({ error: "not-an-attachment" }, 400);
          }
          if (bytes === null) return json({ error: "no-such-attachment" }, 404);
          return new Response(bytes.buffer as ArrayBuffer, {
            headers: {
              // Never the type the sender claimed - that is a claim, and letting
              // it decide how a browser renders bytes is how a file becomes a
              // script. The type is read off the bytes instead, and only four
              // image types are recognised. Everything else is octet-stream.
              "content-type": sniffImageType(bytes) ?? "application/octet-stream",
              "content-disposition": "inline",
              "x-content-type-options": "nosniff",
              "cache-control": "private, max-age=31536000, immutable",
            },
          });
        }

        // Attach a file to a conversation (RFC-11).
        //
        // The bytes are stored and an entry records that they exist. Nothing is
        // sent here - attaching and sending are separate acts, and a file that
        // is never sent is still a fact about the conversation.
        const attach = path.match(/^\/api\/conversations\/([^/]+)\/attachments\/?$/);
        if (attach && req.method === "POST") {
          const id = decodeURIComponent(attach[1] ?? "");
          if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);

          // Read the body as bytes. It is a file, not JSON, and the name and
          // media type ride in headers so the body is exactly the file.
          const name = req.headers.get("x-lucid-filename") ?? "";
          const contentType = req.headers.get("content-type") ?? "application/octet-stream";
          if (!isArtifactField(name)) return json({ error: "filename-required" }, 400);

          if (!isArtifactField(contentType)) return json({ error: "attachment-invalid" }, 400);

          const raw = new Uint8Array(await req.arrayBuffer());
          // Checked here as well as in the store. The endpoint is the rule and
          // the browser is a convenience; a body this large should not have
          // been read, and a later bound is not an excuse for no bound.
          if (!withinAttachmentBound(raw.byteLength)) {
            return json({ error: "attachment-too-large" }, 413);
          }

          const dir = dirForRequest(id);
          return withWriter(dir, id, (host) => {
            const result = host.writeAttachment({
              bytes: raw,
              contentType,
              name,
              // Decided on the bytes, once, and recorded. The media type states
              // what the browser claims and the extension states less.
              text: isTextBytes(raw),
            });
            if (result.verdict === "refused") {
              return json(
                { error: result.issue },
                result.issue === "attachment-too-large" ? 413 : 400,
              );
            }
            return json({
              hash: result.hash,
              bytes: raw.byteLength,
              contentType,
              name,
              text: isTextBytes(raw),
            });
          });
        }

        if (write && req.method === "POST") {
          const id = decodeURIComponent(write[1] ?? "");
          if (!validConversationId(id)) return json({ error: "invalid-conversation-id" }, 400);
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return json({ error: "invalid-json" }, 400);
          }
          if (body === null || typeof body !== "object" || Array.isArray(body))
            return json({ error: "text-required" }, 400);
          const value = (body as { text?: unknown }).text;
          const requestedId = (body as { id?: unknown }).id;
          if (
            requestedId !== undefined &&
            (typeof requestedId !== "string" || !isWireId(requestedId))
          )
            return json({ error: "invalid-input-id", verdict: "refused" }, 400);
          if (typeof value !== "string") {
            return json({ error: "text-required" }, 400);
          }
          if (value.length > TEXT_MAX) return json({ error: "text-too-large" }, 413);
          const dir = dirForRequest(id);
          return await withWriter(dir, id, async (host) => {
            const inputId =
              typeof requestedId === "string" ? requestedId : `browser-${randomUUID()}`;
            const input = { id: inputId, text: value, mode: "queue" as const };
            const reply = (result: ReturnType<ConversationHost["acceptInput"]>): Response => {
              if (result.verdict === "refused") {
                return json(
                  { error: result.issue, inputId, verdict: "refused" },
                  result.issue === "E-COMP-06"
                    ? 409
                    : result.issue === "input-queue-full"
                      ? 429
                      : 400,
                );
              }
              wakeNaming();
              requestManaged(id, inputId);
              const batch = detectAnnotationBatch(value);
              return json({
                ...result.receipt,
                ...(batch && !("malformed" in batch) && batch.notes.length === 1
                  ? { noteIndex: 0 }
                  : {}),
                verdict: "accepted",
              });
            };
            // The host compares the original payload under the append lock.
            // An existing receipt does not depend on today's driver defaults.
            if (host.hasAcceptedInput(inputId)) return reply(host.acceptInput(input));
            if (value.trim() === "")
              return json({ error: "text-required", inputId, verdict: "refused" }, 400);
            const saved = preferenceState(dir);
            const completed =
              !saved.error && !saved.revision
                ? (await settings.project(dir)).conversationSettings.selected
                : null;
            return reply(
              host.acceptInput(input, {
                completeSettings: completed ?? undefined,
                managed: opts.managedLaunch !== undefined,
              }),
            );
          });
        }

        return text("not found", 404);
      } catch (cause) {
        if (cause instanceof RecordLookupError)
          return json(
            { code: "E-HUB-01", error: cause.reason },
            cause.reason === "not-found" ? 404 : cause.reason === "root-unavailable" ? 503 : 409,
          );
        const code = classifyStoreFailure(cause);
        if (code === "record-busy") return json({ error: code }, 503);
        if (code === "record-unreadable") return json({ error: "damaged" }, 409);
        throw cause;
      }
    },
  });

  // `port: 0` is how a test asks the kernel for a free port, so the bound
  // port is read back from the server rather than echoed from the request.
  const bound = server.port ?? port;
  ownOrigins = new Set([`http://127.0.0.1:${bound}`, `http://localhost:${bound}`]);
  // Only a successfully bound server may discover work or launch children.
  // A failed bind must not create a fresh reconciler that launches on startup.
  const discovery = watchConversations(rootDir, { scan: records.list });
  wakeNaming();
  const managedTimer = opts.managedLaunch
    ? setInterval(reconcileManaged, Math.min(5000, Math.max(1, opts.reconcileMs ?? 5000)))
    : undefined;
  managedTimer?.unref();
  reconcileManaged();
  return {
    port: bound,
    token,
    url: `http://127.0.0.1:${bound}`,
    close: async () => {
      folderPicker.close();
      clearInterval(managedTimer);
      discovery.close();
      await server.stop(true);
    },
  };
};
