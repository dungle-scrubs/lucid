import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { LucidError } from "../errors.ts";

/**
 * The wide-event boundary: one structured record per hub request, built as
 * the request flows and emitted once (plan 07, D-004). This module owns the
 * record's SHAPE and its SINK - it owns neither routing nor any decision
 * about what a route does. Records carry identifiers and outcomes only,
 * never prompts, notes or artifact bodies (D-005).
 */

/** One line in, no return - the shape every sink, mirror and log share. */
export type LineSink = (line: string) => void;

export interface ObserveOptions {
  /** Where emitted lines go. Injected by tests; the hub passes its sink. */
  readonly sink: LineSink;
  /** Epoch-ms clock, injectable so duration is deterministic under test. */
  readonly clock?: () => number;
}

/** What a request is - the three identifiers no record makes sense without. */
export interface RequestIdentity {
  readonly method: string;
  readonly path: string;
  readonly id: string;
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

export interface RequestObservation {
  /** Merge named identifiers onto the record - attach, don't log. */
  attach(context: RequestContext): void;
  /** Stamp a typed error's identity onto the record: `error.type` is the
   *  tag, `error.code` the stable code - technique 3 feeding the event.
   *  Never the message or detail, which may carry the review's content. */
  fail(error: LucidError): void;
  /** Emit the exit record. Idempotent by contract: one record per request. */
  end(status: number): void;
}

export const startRequest = (
  request: RequestIdentity,
  options: ObserveOptions,
): RequestObservation => {
  const { method, path, id } = request;
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const context: { -readonly [K in keyof RequestContext]: RequestContext[K] } = {};
  let failure: { readonly type: string; readonly code: string } | undefined;
  let ended = false;
  return {
    attach(next: RequestContext): void {
      if (next.artifact !== undefined) context.artifact = next.artifact;
      if (next.project !== undefined) context.project = next.project;
      if (next.session !== undefined) context.session = next.session;
      if (next.view !== undefined) context.view = next.view;
      if (next.harness !== undefined) context.harness = next.harness;
    },
    fail(error: LucidError): void {
      failure = { type: error._tag, code: error.code };
    },
    end(status: number): void {
      if (ended) return;
      ended = true;
      options.sink(
        JSON.stringify({
          event: "request",
          id,
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
    options.mirror?.(message);
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
