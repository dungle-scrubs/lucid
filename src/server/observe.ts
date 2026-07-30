import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { isLucidError } from "../errors.ts";
import { mintRequestId, REQUEST_ID_HEADER, WELL_FORMED_ID } from "../core/request-id.ts";

export { REQUEST_ID_HEADER } from "../core/request-id.ts";

/**
 * The wide-event boundary: one structured record per hub request, built as
 * the request flows and emitted once (plan 07, D-004). This module owns the
 * record's SHAPE and its SINK - it owns neither routing nor any decision
 * about what a route does. Records carry identifiers and outcomes only,
 * never prompts, notes or artifact bodies (D-005).
 *
 * For a streaming route (SSE), the exit record fires when the Response is
 * returned: `status` is real, and `durationMs` means time-to-headers there
 * rather than the life of the stream.
 */

/** One line in, no return - the shape every sink, mirror and log share. */
export type LineSink = (line: string) => void;

export interface ObserveOptions {
  /** Where emitted lines go. Injected by tests; the hub passes its sink. */
  readonly sink: LineSink;
  /** Millisecond clock (monotonic by default), injectable so duration is
   *  deterministic under test. */
  readonly clock?: () => number;
}

/** What a request is. `id` is the record's OWN key - fresh per record,
 *  never adopted - and pairs an entry with its exit. `trace` is the carried
 *  value that joins a click to every hop it caused (D-011); it defaults to
 *  the id at the edge where a trace is born. */
export interface RequestIdentity {
  readonly method: string;
  readonly path: string;
  readonly id: string;
  readonly trace?: string;
}

/**
 * The business context a route may attach - NAMED identifiers only. The
 * builder never spreads an arbitrary object into the record: a prompt or an
 * artifact body handed over by mistake must have nowhere to land (D-005).
 */
export interface RequestContext {
  readonly artifact?: string;
  readonly project?: string;
  readonly session?: string;
  readonly view?: string;
  readonly harness?: string;
}

/** What `fail` keeps of an error: the tag and the stable code. Every typed
 *  error satisfies it structurally; message and detail have no field here. */
export interface ErrorIdentity {
  readonly _tag: string;
  readonly code: string;
}

export interface RequestObservation {
  /** The record's own key - pairs this entry with this exit, nothing else. */
  readonly id: string;
  /** The carried join key (D-011) - what a route hands to work that OUTLIVES
   *  the request (a spawned turn), so the offspring's records join the
   *  click's. */
  readonly trace: string;
  /** Merge named identifiers onto the record - attach, don't log. */
  attach(context: RequestContext): void;
  /** Stamp a typed error's identity onto the record: `error.type` is the
   *  tag, `error.code` the stable code - technique 3 feeding the event.
   *  Never the message or detail, which may carry the review's content. */
  fail(error: ErrorIdentity): void;
  /** Emit the exit record. Idempotent by contract: one record per request. */
  end(status: number): void;
}

/** An identifier longer than this is not an identifier. Caps every
 *  caller-influenced string on the record, so no single request can write a
 *  line bigger than the log's own rotation budget and rotate real evidence
 *  away (R2) - the create body was never the biggest lever; the request
 *  target itself was. */
const FIELD_CAP = 256;
const capField = (value: string): string => value.slice(0, FIELD_CAP);

export const startRequest = (
  request: RequestIdentity,
  options: ObserveOptions,
): RequestObservation => {
  const method = capField(request.method);
  const path = capField(request.path);
  const { id } = request;
  const trace = request.trace ?? id;
  // performance.now, not Date.now: sub-ms resolution means a fast loopback
  // route still records a real, non-zero duration.
  const clock = options.clock ?? ((): number => performance.now());
  const startedAt = clock();
  // The entry record. A record written only on completion is evidence only
  // about requests that completed - and the request being chased is the one
  // that hung. Entry with no exit is what a hang LOOKS like in the file.
  options.sink(JSON.stringify({ event: "request.start", id, trace, method, path }));
  const context: { -readonly [K in keyof RequestContext]: RequestContext[K] } = {};
  let failure: { readonly type: string; readonly code: string } | undefined;
  let ended = false;
  return {
    id,
    trace,
    attach(next: RequestContext): void {
      if (next.artifact !== undefined) context.artifact = capField(next.artifact);
      if (next.project !== undefined) context.project = capField(next.project);
      if (next.session !== undefined) context.session = capField(next.session);
      if (next.view !== undefined) context.view = capField(next.view);
      if (next.harness !== undefined) context.harness = capField(next.harness);
    },
    fail(error: ErrorIdentity): void {
      failure = { type: error._tag, code: error.code };
    },
    end(status: number): void {
      if (ended) return;
      ended = true;
      options.sink(
        JSON.stringify({
          event: "request",
          id,
          trace,
          method,
          path,
          status,
          durationMs: clock() - startedAt,
          ...context,
          ...(failure ? { error: failure } : {}),
        }),
      );
    },
  };
};

/** The trace a CLI process sends: adopt `LUCID_REQUEST_ID` when a spawned
 *  turn holds one (its hub calls then join the click that spawned it), mint
 *  otherwise. Malformed values are replaced, same as the header rule. */
export const cliRequestId = (env: NodeJS.ProcessEnv = process.env): string => {
  const held = env.LUCID_REQUEST_ID;
  return held !== undefined && WELL_FORMED_ID.test(held) ? held : mintRequestId();
};

/** Adopt a well-formed inbound trace, refuse anything else (M1.3, R4).
 *  Adoption is what joins the hops: the caller that already holds a trace
 *  sees the hub's records carry the SAME one. */
export const inboundTrace = (headers: Headers): string | undefined => {
  const inbound = headers.get(REQUEST_ID_HEADER);
  return inbound !== null && WELL_FORMED_ID.test(inbound) ? inbound : undefined;
};

/**
 * Wrap the hub's one request funnel so EVERY request emits - the wide event
 * is made here, not in routes. The handler gets the observation to attach
 * business context where the route knows it; a throw is recorded (typed
 * errors keep their identity) and rethrown - responding to it stays the
 * caller's job, so this wrapper decides nothing about routing.
 */
export const observeRequests = (
  options: ObserveOptions,
  handler: (req: Request, observation: RequestObservation) => Promise<Response>,
): ((req: Request) => Promise<Response>) => {
  return async (req: Request): Promise<Response> => {
    // NEVER let path derivation lose the record: an authority-form target
    // (CONNECT host:port) is not a parseable URL, and a throw here - before
    // the observation exists - was the one request that produced a Response
    // with zero evidence. The raw target rides instead; evidence beats
    // purity (adversarial review of #89).
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      pathname = req.url;
    }
    const trace = inboundTrace(req.headers);
    const observation = startRequest(
      {
        method: req.method,
        path: pathname,
        id: mintRequestId(),
        ...(trace !== undefined ? { trace } : {}),
      },
      options,
    );
    try {
      const response = await handler(req, observation);
      observation.end(response.status);
      return response;
    } catch (err) {
      if (isLucidError(err)) observation.fail(err);
      else if (err instanceof Error) {
        // An UNTYPED throw is the failure class nobody predicted - the one
        // the record must not stay silent about. The name is identity; the
        // message stays out (it can quote anything, D-005).
        observation.fail({ _tag: err.name, code: "UNKNOWN" });
      }
      observation.end(500);
      throw err;
    }
  };
};

/** Resolve the hub log path: explicit override, then env, then default -
 *  the same contract as `registryFilePath`, and `LUCID_HUB_LOG` is what
 *  lets the test harness keep suite hubs out of the developer's real home
 *  (ENV_POLICY: isolate). */
export const hubLogPath = (path?: string): string => {
  if (path) return path;
  if (process.env.LUCID_HUB_LOG) return process.env.LUCID_HUB_LOG;
  return resolve(homedir(), ".lucid", "hub.log");
};

/** One rotation at 5 MB - tens of thousands of request lines per
 *  generation, and the cap plus a single previous generation bounds
 *  growth (R2). */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** The line every emitter used to end at: stdout, one message per line. */
export const stdoutSink: LineSink = (m) => process.stdout.write(`${m}\n`);

export interface LogSinkOptions {
  readonly path?: string;
  readonly maxBytes?: number;
  /** Also mirror each line here (stdout in the hub); tests omit it. */
  readonly mirror?: LineSink;
}

/**
 * A line-oriented sink backed by a rotating file. Rotation happens BEFORE a
 * write that would cross the cap: the current file becomes `<path>.1`
 * (replacing the previous generation - exactly one is kept, D-002) and the
 * line starts a fresh file. Writes are synchronous so a crash right after a
 * request still leaves its line on disk - the whole point of the file. The
 * size check is a stat, not a tracked count, so an external truncation or
 * rotation self-corrects instead of poisoning every later decision.
 */
export const createLogSink = (options: LogSinkOptions = {}): LineSink => {
  const path = hubLogPath(options.path);
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  let ready = false;
  return (message: string): void => {
    const line = `${message}\n`;
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true });
        ready = true;
      }
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        // No file yet - first write creates it.
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        renameSync(path, `${path}.1`);
      }
      appendFileSync(path, line);
    } catch {
      // A sink that cannot write must never take a request down with it.
      // Un-latch so a recreated ~/.lucid is picked up on the next line;
      // M3.2 gives write health an inspection surface.
      ready = false;
    }
    try {
      options.mirror?.(message);
    } catch {
      // A closed stdout pipe must not turn every request into a 500 - the
      // file already has the line, which is the copy that matters.
    }
  };
};

export interface HubSinkOptions {
  /** An injected sink wins outright - tests and embedding callers keep the
   *  plain `(message: string) => void` contract they always had. */
  readonly log?: LineSink;
  readonly hubLogPath?: string;
  /** Where the file's lines are mirrored. Defaults to stdout, so a
   *  foreground hub still narrates. */
  readonly mirror?: LineSink;
}

/**
 * The hub's ONE sink (D-009). Every in-daemon emitter - the request
 * records, attend's narration, the stray console call - resolves through
 * here, so no hub evidence is left on bare stdout to evaporate when the
 * hub runs detached.
 */
export const resolveHubSink = (options: HubSinkOptions = {}): LineSink =>
  options.log ??
  createLogSink({
    ...(options.hubLogPath !== undefined ? { path: options.hubLogPath } : {}),
    mirror: options.mirror ?? stdoutSink,
  });
