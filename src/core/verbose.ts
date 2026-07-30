/**
 * The scoped verbose toggle (plan 07, M3.1 - the doctrine's technique 4).
 *
 * Turns on INTERNAL narration for one subsystem at a time, for the two places
 * whose behaviour is genuinely opaque: anchor resolution ("which layer matched
 * this element, and why were the others skipped") and the attend engine ("why
 * did this turn not run"). Both currently answer those questions with silence.
 *
 * The DEFAULT is the technique. Narration is silent until a subsystem is
 * named, because always-on internal tracing is noise wearing observability's
 * name. The scope word is equally load-bearing in the other direction: this
 * flag governs internal narration ONLY. It must never gate the boundary
 * records from Phase 1, which are baseline evidence and always on - read as a
 * blanket silence rule it would cancel them, leaving a program that emits
 * nothing and calls that observability.
 *
 * This module owns the flag's vocabulary and the no-op path. It owns no
 * subsystem's messages, and no sink of its own beyond the default.
 */

/** The subsystems that can be made loud. A name outside this list is dropped
 *  rather than guessed at - a typo must not silently mean "off" somewhere the
 *  human believed it meant "on", so the list is closed and checkable. */
export const VERBOSE_SUBSYSTEMS = ["anchors", "attend"] as const;

export type VerboseSubsystem = (typeof VERBOSE_SUBSYSTEMS)[number];

export interface VerboseEnv {
  readonly LUCID_VERBOSE?: string | undefined;
  readonly [key: string]: string | undefined;
}

/** The ambient environment, or nothing at all. This module is imported by
 *  `src/anchors/dom.ts`, which is bundled into the BROWSER overlay - a bare
 *  `process.env` there is a ReferenceError at module load, and the overlay
 *  never registers. The guard is why the flag is server-side only, which is
 *  correct: there is no environment to read in a page. */
const ambientEnv = (): VerboseEnv =>
  typeof process === "undefined" ? {} : (process.env as VerboseEnv);

/** The default narration sink. NOT stdout: `lucid`'s stdout is one JSON
 *  document, so narration there would corrupt it. Absent in a browser, where
 *  the flag cannot be set anyway. */
const stderrSink = (line: string): void => {
  if (typeof process !== "undefined") process.stderr.write(`${line}\n`);
};

/**
 * Where THIS process's narration goes. One place decides, because the answer
 * differs per process and a module-level default cannot know which it is in:
 * the hub is normally started detached with stdio "ignore", so stderr there is
 * /dev/null - narration written to it is not quiet, it is LOST, which is worse
 * than being off because the flag looks like it did something.
 *
 * The hub points this at its own rotating log (the file that exists precisely
 * because a detached hub's evidence must survive). Everything else - the CLI,
 * a standalone session server whose stderr is captured to `run/server.out.log`
 * - leaves it at stderr, which is right for them.
 */
let narrationSink: ((line: string) => void) | undefined;

/**
 * Point this process's narration at a durable sink. Called by the hub.
 * Returns a restore function: a daemon that stops must give the sink back,
 * or every later trace in that process writes into a dead closure - which is
 * the whole reason narration was being lost in the first place, one layer up.
 */
export const setNarrationSink = (sink: (line: string) => void): (() => void) => {
  const previous = narrationSink;
  narrationSink = sink;
  return () => {
    narrationSink = previous;
  };
};

/** Parse the flag: a comma-separated list, trimmed and lowercased, with `all`
 *  as the one spelling for "be loud everywhere". */
export const verboseSubsystems = (env: VerboseEnv): VerboseSubsystem[] => {
  const raw = env.LUCID_VERBOSE?.trim().toLowerCase() ?? "";
  if (raw === "") return [];
  const named = raw.split(",").map((s) => s.trim());
  if (named.includes("all")) return [...VERBOSE_SUBSYSTEMS];
  return VERBOSE_SUBSYSTEMS.filter((s) => named.includes(s));
};

/** The names in the flag that name nothing. `LUCID_VERBOSE=1` is the single
 *  most likely thing a human types, and dropping it in silence is the failure
 *  this list being "closed and checkable" was supposed to prevent - a flag
 *  that looks set and does nothing. */
export const unknownSubsystems = (env: VerboseEnv): string[] => {
  const raw = env.LUCID_VERBOSE?.trim().toLowerCase() ?? "";
  if (raw === "") return [];
  const known = new Set<string>([...VERBOSE_SUBSYSTEMS, "all"]);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !known.has(s));
};

/** Say so, once per process, when the flag names something unrecognised.
 *
 *  Through the NARRATION sink, not stderr: in the hub, stderr is /dev/null,
 *  and a warning discarded there is the same defect this warning exists to
 *  report - something that looks like it worked and did nothing. */
const warnedSinks = new Set<unknown>();
export const warnUnknownSubsystems = (env: VerboseEnv = ambientEnv()): void => {
  const unknown = unknownSubsystems(env);
  if (unknown.length === 0) return;
  // Once per SINK, not once per process. `lucid hub` warns from the CLI
  // wrapper before the daemon installs its log, so a process-wide latch let
  // that first stderr write - discarded in a detached hub - consume the only
  // warning, and the durable sink never saw it. Each destination says it once.
  const sink = narrationSink ?? stderrSink;
  if (warnedSinks.has(sink)) return;
  warnedSinks.add(sink);
  sink(
    `[verbose] LUCID_VERBOSE names ${unknown.map((u) => `"${u}"`).join(", ")}, ` +
      `which is not a subsystem - known: ${VERBOSE_SUBSYSTEMS.join(", ")}, all`,
  );
};

/** Tests only: let one test process observe the per-sink warning again. */
export const resetUnknownWarning = (): void => {
  warnedSinks.clear();
};

/** Is this ONE subsystem loud? Scoped, so turning on anchors cannot drown the
 *  reader in attend. */
export const isVerbose = (subsystem: VerboseSubsystem, env?: VerboseEnv): boolean =>
  verboseSubsystems(env ?? ambientEnv()).includes(subsystem);

/** A narration line, produced only if anyone is listening. */
export type TraceMessage = () => string;

export interface TracerOptions {
  readonly env?: VerboseEnv;
  readonly sink?: (line: string) => void;
}

/**
 * A subsystem's narrator. Returns a no-op when the subsystem is not named, so
 * call sites narrate unconditionally and carry no `if (verbose)` of their own.
 *
 * The message is a THUNK: describing what a resolver just did can cost real
 * work (walking a DOM, formatting a fingerprint), and that work must not
 * happen when nobody asked for it. A string parameter would make the silent
 * default cost more than the loud one on every call.
 */
export const tracer = (
  subsystem: VerboseSubsystem,
  options: TracerOptions = {},
): ((message: TraceMessage) => void) => {
  // Resolved on FIRST USE, not at construction. Two reasons, both real: this
  // is constructed at module scope in files that also load in the browser
  // (see `ambientEnv`), and a construction-time snapshot made the flag depend
  // on import order rather than on the process's environment.
  let enabled: boolean | undefined;
  return (message: TraceMessage): void => {
    enabled ??= isVerbose(subsystem, options.env);
    if (!enabled) return;
    // Resolved per line, not at construction: the hub installs its sink after
    // this module's importers have already built their tracers.
    const sink = options.sink ?? narrationSink ?? stderrSink;
    sink(`[${subsystem}] ${message()}`);
  };
};
