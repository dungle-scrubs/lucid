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

export interface ObserveOptions {
  /** Where emitted lines go. Injected by tests; the hub passes its sink. */
  readonly sink: (line: string) => void;
  /** Epoch-ms clock, injectable so duration is deterministic under test. */
  readonly clock?: () => number;
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
   *  tag, `error.code` the stable code - technique 3 feeding the event. */
  fail(error: LucidError): void;
  /** Emit the exit record. Idempotent by contract: one record per request. */
  end(status: number): void;
}

export const startRequest = (
  method: string,
  path: string,
  id: string,
  options: ObserveOptions,
): RequestObservation => {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const context: {
    artifact?: string;
    project?: string;
    session?: string;
    view?: string;
    harness?: string;
  } = {};
  let failure: { readonly type: string; readonly code: string } | undefined;
  let ended = false;
  return {
    attach(next: RequestContext): void {
      // Field by field, never a spread: an unknown key has nowhere to land.
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

/** Default sink location - beside the registry, per the `~/.lucid` home
 *  convention (`src/core/registry.ts`). */
export const defaultLogPath = (): string => resolve(homedir(), ".lucid", "hub.log");

/** One rotation at 5 MB: a request line is small, so this is months of
 *  evidence, and the cap plus a single previous generation bounds growth (R2). */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface LogSinkOptions {
  readonly path?: string;
  readonly maxBytes?: number;
  /** Also mirror each line here (stdout in the hub); tests omit it. */
  readonly mirror?: (line: string) => void;
}

/**
 * A line-oriented sink backed by a rotating file. Rotation happens BEFORE a
 * write that would cross the cap: the current file becomes `<path>.1`
 * (replacing the previous generation - exactly one is kept, D-002) and the
 * line starts a fresh file. Writes are synchronous so a crash right after a
 * request still leaves its line on disk - the whole point of the file.
 */
export const createLogSink = (options: LogSinkOptions = {}): ((message: string) => void) => {
  const path = options.path ?? defaultLogPath();
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
      // A sink that cannot write must never take a request down with it;
      // `lucid status` reports write health instead (M3.2).
    }
    options.mirror?.(message);
  };
};

export interface HubSinkOptions {
  /** An injected sink wins outright - tests and embedding callers keep the
   *  plain `(message: string) => void` contract they always had. */
  readonly log?: (message: string) => void;
  readonly logPath?: string;
  /** Where the file's lines are mirrored. Defaults to stdout, so a
   *  foreground hub still narrates. */
  readonly mirror?: (line: string) => void;
}

/**
 * The hub's ONE sink (D-009). Every emitter - the request records, attend's
 * narration, the stray console call - resolves through here, so nothing is
 * left writing to bare stdout that evaporates when the hub runs detached.
 */
export const resolveHubSink = (options: HubSinkOptions = {}): ((message: string) => void) =>
  options.log ??
  createLogSink({
    ...(options.logPath !== undefined ? { path: options.logPath } : {}),
    mirror: options.mirror ?? ((m) => process.stdout.write(`${m}\n`)),
  });
