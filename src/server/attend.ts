import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tracer } from "../core/verbose.ts";
import {
  artifactAttendant,
  readAttendantSidecars,
  recordSessionInvalidation,
  resolveResumeCandidates,
  type ResumeCandidate,
} from "../core/attendant.ts";
import { deliver } from "../core/deliver.ts";
import { shellArg } from "../core/escape.ts";
import type { LogEvent, LogEventType } from "../core/events.ts";
import { foldLog, type FoldedState } from "../core/fold.ts";
import { readEvents } from "../core/log.ts";
import { ARTIFACT_DIR, projectRootOf } from "../core/paths.ts";
import type { SessionPaths } from "../core/paths.ts";
import { assemblePayload } from "../core/payload.ts";
import {
  harnessSessionCwd,
  harnessSessionId,
  harnessStoreHas,
  presenceFor,
} from "../core/presence.ts";
import { scratchpadProject } from "../core/scratchpad.ts";
import { discoveryPersistence, revisePrompt, runSpawn } from "../launch/launcher.ts";
import {
  classifyObservedIdentity,
  classifySessionFailure,
  mintLaunchId,
} from "../launch/session-identity.ts";
import { detectUsageLimit } from "../launch/limits.ts";
import {
  buildArgv,
  loadRegistry,
  normalizeHarness,
  resolveRecipe,
  spawnedSessionId,
  type SpawnRecipe,
} from "../launch/recipes.ts";
import { insertSelectionArgs, readSelection, selectionArgs } from "../launch/selection.ts";

/**
 * The attend engine (D15/D19): delivery is Lucid's job. When feedback sits
 * undelivered on an artifact and NOTHING is listening, the hub drives the
 * headless turn itself instead of waiting for a human to go re-summon a
 * conversation.
 *
 * Precedence is the whole point: an interactive attendant holds hour-long
 * `wait` windows, so a live listener always wins and the hub only steps in
 * where the human would otherwise have had to. "Listening" is broader than an
 * open stream - an agent that took delivery and is mid-turn holds the batch
 * too, which is exactly the window (30s-5min of editing) where a naive
 * listener count reads zero. Opt-in only (`lucid hub --attend`) - D-064 is
 * amended to "never spawns agents WITHOUT explicit opt-in", not repealed.
 */

/** Feedback the HUMAN produced and a revise turn can act on. Agent-originated
 *  events (versions, replies, acks, questions) are never something to deliver
 *  back to the agent, and a `fork` asks for a NEW artifact - the launcher's
 *  job (D-064), never a revise turn on this one, so the hub does not count it
 *  as its own to deliver. */
const HUMAN_EVENTS: ReadonlySet<LogEventType> = new Set<LogEventType>([
  "annotation",
  "prompt",
  "revert",
  "question_answered",
]);

/** Default quiet window before a batch is driven: a burst of annotations sent
 *  together must arrive as ONE turn, not one turn per annotation. */
export const DEFAULT_ATTEND_DEBOUNCE_MS = 3000;

/** Consecutive failed turns before this mount stops trying for a while. A
 *  broken recipe must not spin an agent process every poll. */
const MAX_ATTEND_FAILS = 3;

/**
 * How long attendance pauses after a structural failure (a malformed harness
 * registry, a recipe whose executable is missing, an artifact with nothing to
 * resume). Long enough that a broken configuration cannot spin, short enough
 * that fixing it takes effect without restarting the hub - and never
 * permanent, because the hub outlives every mistake it is asked to attend.
 */
const ATTEND_COOLOFF_MS = 5 * 60 * 1000;

/**
 * How long an open "agent is working" window keeps the hub out. The window is
 * opened by an ack and closed by real output, so an agent that acked and then
 * died would otherwise silence the hub forever. Every re-ack (`lucid intent`,
 * `lucid progress`) refreshes it, so a long fan-out that keeps reporting keeps
 * its claim - only silence expires.
 */
const DEFAULT_WORKING_GRACE_MS = 10 * 60 * 1000;

/** Seqs of human feedback nobody has taken delivery of yet. */
export const pendingHumanSeqs = (
  events: readonly LogEvent[],
  deliveredUpTo: number,
): readonly number[] =>
  events.filter((e) => e.seq > deliveredUpTo && HUMAN_EVENTS.has(e.t)).map((e) => e.seq);

/** Epoch ms of the newest ack in the log, or undefined when there is none. */
const lastAckAt = (events: readonly LogEvent[]): number | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e?.t !== "agent_ack") continue;
    const at = Date.parse(e.at);
    return Number.isFinite(at) ? at : undefined;
  }
  return undefined;
};

export interface AttendDecisionInput {
  /** Human-feedback seqs past the delivered cursor. */
  readonly pendingFeedbackSeqs: readonly number[];
  /** Agents blocked in `wait` on this artifact right now. */
  readonly listening: number;
  /**
   * Epoch ms an agent's still-open working window was last refreshed, or
   * undefined when no agent is working. An agent between "I took the batch"
   * and "here is the result" is not listening but is not gone either.
   */
  readonly workingSince: number | undefined;
  /** Epoch ms the oldest still-pending batch was first observed. */
  readonly firstPendingAt: number | undefined;
  readonly now: number;
  /** A turn this watcher started is still running. */
  readonly inFlight: boolean;
  readonly debounceMs: number;
  /** How long an unrefreshed working window keeps the hub out. */
  readonly workingGraceMs: number;
}

/** `idle` = nothing to deliver · `wait` = someone/something else has it, or the
 *  batch is still settling · `spawn` = drive the turn now. */
export type AttendDecision = "spawn" | "wait" | "idle";

/**
 * The whole delivery policy, as one pure function: no clock, no filesystem, no
 * process. Everything the watcher does around it is plumbing.
 */
/** The decision AND the precondition that produced it (M3.1). "Why did this
 *  turn not run" had no answer anywhere; the verdict alone cannot give one,
 *  and a second copy of the rules would drift from the first. So the reasons
 *  live here, beside the rules, and `attendDecision` is derived. */
export interface AttendVerdict {
  readonly decision: AttendDecision;
  readonly reason: string;
}

/** How much of a quiet turn's own output is relayed as its reply. */
const SILENT_TURN_TAIL = 600;

/** Upper bound on an EXTRACTED final message (a real message, not a slice -
 *  but log.ndjson holds it forever, so a pathological one is still bounded). */
const FINAL_MESSAGE_MAX = 4000;

/** Lucid's OWN narration is not the agent's words: `LUCID_VERBOSE` propagates
 *  into the spawned turn (it inherits the environment) and that turn's stderr
 *  is the attend log this reads, so without the filter a relay can carry
 *  `[anchors] …` lines - delivered as an `agent_reply`, shown in the viewer as
 *  something the agent said, and recorded permanently in log.ndjson. */
const stripNarration = (output: string): string =>
  output
    .split("\n")
    .filter((line) => !/^\[(anchors|attend|verbose)\]/.test(line.trimStart()))
    .join("\n")
    .trim();

/**
 * What of a quiet turn's output may be relayed to the human as the agent's
 * words, when the harness's framing is unknown: the filtered tail, bounded.
 */
export const relayableTail = (output: string): string =>
  stripNarration(output).slice(-SILENT_TURN_TAIL).trim();

/**
 * The final agent message of a codex-exec run, or undefined when the output
 * does not carry codex's framing. codex ends every run with a footer of
 * exactly `tokens used` / `<count>` on their own lines, and everything AFTER
 * the count is the agent's closing message, verbatim.
 *
 * Scanned from the end: the attend log accumulates runs, so the last valid
 * footer belongs to the run that just finished. A "tokens used" the agent
 * happened to SAY fails the count-line check and the scan keeps walking back.
 */
const codexJsonFinalMessage = (
  output: string,
): { readonly message?: string; readonly recognized: boolean } => {
  let message: string | undefined;
  let recognized = false;
  for (const line of output.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (typeof event.type !== "string" || !/^(?:item|thread|turn)\./.test(event.type)) continue;
    recognized = true;
    if (event.type !== "item.completed") continue;
    if (typeof event.item !== "object" || event.item === null || Array.isArray(event.item))
      continue;
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim() !== "") {
      message = item.text;
    }
  }
  return message === undefined ? { recognized } : { message, recognized };
};

const codexTextFinalMessage = (output: string): string | undefined => {
  const marker = "\ntokens used\n";
  for (let at = output.lastIndexOf(marker); at !== -1; at = output.lastIndexOf(marker, at - 1)) {
    const after = output.slice(at + marker.length);
    const newline = after.indexOf("\n");
    if (newline === -1) continue;
    if (!/^[\d,]+$/.test(after.slice(0, newline).trim())) continue;
    const message = after.slice(newline + 1).trim();
    return message === "" ? undefined : message;
  }
  return undefined;
};

export const codexFinalMessage = (output: string): string | undefined => {
  const structured = codexJsonFinalMessage(output);
  return structured.recognized ? structured.message : codexTextFinalMessage(output);
};

/**
 * The words a quiet turn gets relayed under: the harness's own final message
 * when the output carries a framing this engine knows how to read, else the
 * bounded tail. The tail was the whole story once, and a 600-byte slice of a
 * codex run cut mid-diff - raw HTML delivered as the agent's reply, rendered
 * as markdown code blocks in the viewer.
 */
export const relayableReply = (output: string): string => {
  const structured = codexJsonFinalMessage(output);
  if (structured.recognized && structured.message === undefined) return "";
  const final = structured.recognized ? structured.message : codexTextFinalMessage(output);
  if (final === undefined) return relayableTail(output);
  return stripNarration(final).slice(0, FINAL_MESSAGE_MAX).trim();
};

export const attendReason = (input: AttendDecisionInput): AttendVerdict => {
  if (input.pendingFeedbackSeqs.length === 0) {
    return { decision: "idle", reason: "nothing pending: no undelivered feedback on this log" };
  }
  if (input.inFlight) {
    return { decision: "wait", reason: "a delivery is already in flight for this artifact" };
  }
  // A live interactive attendant always takes precedence (Kevin's rule): it
  // holds hour-long wait windows, and the hub only covers the gap after.
  if (input.listening > 0) {
    return {
      decision: "wait",
      reason: `${input.listening} agent(s) listening: a live waiter takes precedence over a spawn`,
    };
  }
  // Mid-turn counts as holding it: two resume processes editing one artifact
  // is the failure this engine exists to avoid, not a faster delivery.
  if (input.workingSince !== undefined && input.now - input.workingSince < input.workingGraceMs) {
    return {
      decision: "wait",
      reason: `a turn is mid-flight (working ${input.now - input.workingSince}ms ago, grace ${input.workingGraceMs}ms)`,
    };
  }
  if (input.firstPendingAt === undefined) {
    return { decision: "wait", reason: "pending feedback has no recorded arrival time yet" };
  }
  if (input.now - input.firstPendingAt < input.debounceMs) {
    return {
      decision: "wait",
      reason: `debounce: ${input.now - input.firstPendingAt}ms since the first pending item, need ${input.debounceMs}ms of quiet`,
    };
  }
  return {
    decision: "spawn",
    reason: `spawning: ${input.pendingFeedbackSeqs.length} pending item(s), quiet for ${input.now - input.firstPendingAt}ms`,
  };
};

export const attendDecision = (input: AttendDecisionInput): AttendDecision =>
  attendReason(input).decision;

export interface AttendantOptions {
  readonly paths: SessionPaths;
  /** Agents currently blocked in `wait` on this mount (the host's count). */
  readonly agentsListening: () => number;
  /** Harness registry file (tests inject; default is recipes.ts's resolution). */
  readonly harnessesPath?: string;
  readonly debounceMs?: number;
  /** How long an unrefreshed working window keeps the hub out (tests). */
  readonly workingGraceMs?: number;
  readonly log: (message: string) => void;
  /** Push a warning frame to the session's own subscribers - how a stalled
   *  delivery says WHY in the viewer, not only in the hub's stdout. */
  readonly warn?: (code: string, message: string) => void;
  /** Internal narration sink (M3.1); tests inject, production reads the flag. */
  readonly trace?: (message: () => string) => void;
  /** The hub this attendant belongs to (plan 08, finding #21). Passed to every
   *  turn it spawns so the turn's own `lucid open` calls back HERE, not at
   *  whatever is listening on the default port. */
  readonly hubPort?: number;
}

export interface Attendant {
  /** One evaluation pass; safe to call on a timer. */
  readonly tick: () => Promise<void>;
  /** Stop evaluating. A turn already running is left to finish. */
  readonly stop: () => void;
}

/** A recorded cwd is a stamp from the log, not a checked path: a session
 *  directory that has since moved would make every spawn fail 127. Fall back
 *  to the artifact's own directory, always a legitimate place to resume from. */
const usableCwd = async (recorded: string | undefined, fallback: string): Promise<string> => {
  if (!recorded) return fallback;
  const ok = await stat(recorded).then(
    (s) => s.isDirectory(),
    () => false,
  );
  return ok ? recorded : fallback;
};

/** A fresh harness owns the artifact, not the source harness's old checkout.
 * Canonical artifacts live under `<project>/.lucid/`, so the directory above
 * `.lucid` is the fallback when no enclosing checkout exists. */
const artifactProjectCwd = (paths: SessionPaths): string =>
  projectRootOf(paths.artifactDir) ??
  (basename(paths.artifactDir) === ARTIFACT_DIR ? dirname(paths.artifactDir) : paths.artifactDir);

/**
 * One artifact's delivery watcher. Created per mount, driven by the daemon's
 * timer.
 *
 * The delivered cursor starts at the log's OWN delivered mark (the last batch
 * an agent acked), so feedback nobody took is driven even when it arrived
 * while nothing was mounted - and feedback somebody already consumed never is.
 * From there it advances on two things: a delivery claim somebody else
 * recorded, and a turn of its own that exited clean.
 */
export const createAttendant = (options: AttendantOptions): Attendant => {
  const { paths, log } = options;
  // Narration rides this process's narration sink, which the hub points at
  // its own rotating log (D-002) - a stderr default would be /dev/null in the
  // only mode this engine runs in. INTERNAL: it never gates, and is never
  // gated by, the always-on boundary records.
  const trace = options.trace ?? tracer("attend");
  const debounceMs = options.debounceMs ?? DEFAULT_ATTEND_DEBOUNCE_MS;
  const workingGraceMs = options.workingGraceMs ?? DEFAULT_WORKING_GRACE_MS;

  let deliveredUpTo: number | undefined;
  let firstPendingAt: number | undefined;
  let inFlight = false;
  let fails = 0;
  let stopped = false;
  /** Epoch ms before which this watcher does nothing (structural back-off). */
  let pausedUntil = 0;
  /** Harness that caused a delivery pause. A deliberate switch bypasses it. */
  let pausedHarness: string | undefined;
  /** The seq of our own outstanding delivery claim. Read back from the log it
   *  would look like somebody else took the batch, and the turn it belongs to
   *  is still being judged by its exit code. */
  let ownClaimSeq = 0;
  /** Log identity (mtime + size) at the last full evaluation: an idle artifact
   *  must not re-read and re-fold its whole log once a second. */
  let lastLogStamp = "";
  /** Epoch ms of a delivery claim that has produced nothing yet. While this is
   *  set the watcher keeps evaluating on the CLOCK (the log will not change if
   *  the turn that took the batch is dead), so the claim can time out. */
  let unfulfilledClaimAt: number | undefined;
  /** Once-per-mount diagnostics: a missing recipe is a standing condition, not
   *  a per-poll event, so it must not fill the hub's output. */
  let saidUnattendable = false;
  /** The last selection-rejection already warned about, so a standing stale
   *  pick warns once instead of on every turn - but a NEW reason still does. */
  let saidSelectionInvalid = "";
  /** Native ids already TRIED for the current undelivered batch (D-004): the
   *  primary plus at most one distinct fallback. Keyed by the batch's covers
   *  seq so a new batch starts fresh; exhaustion is a wall, never a loop. */
  let attemptedForBatch = new Set<string>();
  let attemptedBatchSeq = 0;

  const pauseFor = (ms: number, harness?: string): void => {
    pausedUntil = Date.now() + ms;
    pausedHarness = harness;
  };

  const unattendable = (reason: string): void => {
    // Back off as well as saying so: without a pause this verdict is re-derived
    // (and the registry re-read) on every poll for as long as the mount lives.
    pauseFor(ATTEND_COOLOFF_MS);
    if (saidUnattendable) return;
    saidUnattendable = true;
    log(`attend ${paths.name}: ${reason} - not attending this artifact`);
  };

  /** A failure that is not a turn's exit code: bounded the same way, so a
   *  broken registry or an unreadable payload cannot loop forever. */
  const noteFailure = (message: string): void => {
    fails += 1;
    log(`attend ${paths.name}: ${message} (attempt ${fails})`);
    if (fails < MAX_ATTEND_FAILS) return;
    fails = 0;
    pauseFor(ATTEND_COOLOFF_MS);
    log(`attend ${paths.name}: pausing attendance for ${ATTEND_COOLOFF_MS / 60000} minutes`);
  };

  /**
   * The artifact's sticky selection as argv, or nothing when it no longer
   * validates. A stale pick (the registry dropped the model, the artifact
   * moved to another harness) DEGRADES: the turn runs on the CLI's own
   * defaults and the human is told why, because a stalled delivery is a worse
   * failure than a turn at the wrong effort.
   */
  const applicableSelection = async (
    harnessName: string,
    recipe: SpawnRecipe,
  ): Promise<{ args: readonly string[]; model?: string; effort?: string }> => {
    const selection = await readSelection(paths);
    if (!selection) {
      // Cleared: the next pick is a fresh condition, so it warns even when it
      // repeats the message this mount already said.
      saidSelectionInvalid = "";
      return { args: [] };
    }
    const composed =
      selection.harness !== undefined &&
      normalizeHarness(selection.harness) !== normalizeHarness(harnessName)
        ? {
            error: `the saved pick was made for harness "${selection.harness}", but this artifact resumes under "${harnessName}"`,
          }
        : selectionArgs(harnessName, recipe, selection);
    if ("error" in composed) {
      const message = `Model/effort selection ignored: ${composed.error}. This turn runs on the harness's own defaults.`;
      log(`attend ${paths.name}: ${message}`);
      if (saidSelectionInvalid !== message) {
        saidSelectionInvalid = message;
        options.warn?.("SELECTION_INVALID", message);
      }
      return { args: [] };
    }
    saidSelectionInvalid = "";
    return {
      args: composed,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.effort ? { effort: selection.effort } : {}),
    };
  };

  /**
   * The harness conversation this artifact's turns belong to: which harness,
   * which session id, and where it ran.
   *
   * Two sources, because an artifact can carry either. The LOG's session
   * history is the exact one, stamped by an agent that exported its identity
   * (D18). Failing that, the cursor sidecar an agent writes when it takes
   * delivery names the harness and carries the resume command with the session
   * id inside it - which is what the viewer has always shown as "copy the
   * command to resume", and what presence detection joins on.
   *
   * Reading only the first meant an artifact whose agent never exported
   * `LUCID_SESSION_ID` was declared unattendable ("no harness session recorded")
   * while the panel sat there displaying that very session's resume command.
   */
  /**
   * Where a resume can actually FIND the session. `claude --resume <id>` looks
   * the session up under the project of the directory it runs in, so for an
   * artifact in an agent scratchpad the only workable cwd is the one the
   * scratchpad path encodes - never the scratchpad itself, and never a cwd
   * recorded from inside it (which is what this engine's own earlier acks
   * stamped, so a stale stamp must not win).
   */
  const resumeCwd = async (
    sessionId: string | undefined,
    recorded?: string,
  ): Promise<{ readonly cwd?: string }> => {
    // Where the harness FILED this conversation beats every inference about
    // where it ought to live - see harnessSessionCwd.
    const filed = sessionId ? await harnessSessionCwd(sessionId) : undefined;
    const decoded = filed ?? (await scratchpadProject(paths.artifactDir));
    const cwd = decoded ?? recorded;
    return cwd ? { cwd } : {};
  };

  /**
   * The ranked resume candidates for this artifact (plan 03, M4): sidecars
   * with explicit authority, corroborated durable bindings, one id a
   * harness-specific parser pulled from the recorded resume command, and a
   * corroborated scratchpad id - in that order, with locally quarantined ids
   * excluded. sessionHistory MENTIONS never rank: an untyped stamp is how the
   * synthetic UUID reached resume argv (the reported failure).
   */
  const attendCandidates = async (state: FoldedState): Promise<readonly ResumeCandidate[]> => {
    const sidecars = await readAttendantSidecars(paths);
    const legacy = await artifactAttendant(paths, state.sessionHistory);
    const scratchpadId = harnessSessionId({ artifactDir: paths.artifactDir });
    return resolveResumeCandidates({
      sidecars,
      bindings: state.bindings,
      corroborate: (harness, sessionId) => harnessStoreHas(harness, sessionId),
      ...(legacy?.resume && legacy.harness
        ? { legacyResume: { command: legacy.resume, harness: legacy.harness } }
        : {}),
      ...(scratchpadId && legacy?.harness
        ? { scratchpad: { harness: legacy.harness, sessionId: scratchpadId } }
        : {}),
    });
  };

  const attendTarget = async (
    state: FoldedState,
  ): Promise<
    | {
        readonly harness: string;
        /** Absent when nothing PROVEN resumable exists: the artifact is still
         *  attendable - by a fresh handoff, which resumes nothing. */
        readonly sessionId?: string;
        readonly cwd?: string;
        readonly fallback?: { readonly harness: string; readonly sessionId: string };
      }
    | undefined
  > => {
    const candidates = await attendCandidates(state);
    const best = candidates[0];
    // The RECORDED association still names who attends and where it sat -
    // placement evidence, not identity; the harness store's own filing
    // (resumeCwd) outranks its cwd when present.
    const recorded = await artifactAttendant(paths, state.sessionHistory);
    if (!best) {
      // No id survives the trust ladder (untyped stamps are display-only,
      // uncorroborated bindings stay put). A recorded HARNESS still supports
      // a fresh handoff; with not even that, there is nothing to attend.
      if (!recorded?.harness) return undefined;
      return {
        harness: recorded.harness,
        ...(await resumeCwd(undefined, recorded.cwd)),
      };
    }
    // The one permitted fallback (D-004): the next DISTINCT id, resolved now
    // so a not-found on the primary needs no second resolution pass.
    const next = candidates.find(
      (c) => c.sessionId !== best.sessionId && c.harness === best.harness,
    );
    return {
      harness: best.harness,
      sessionId: best.sessionId,
      ...(await resumeCwd(best.sessionId, recorded?.cwd)),
      ...(next ? { fallback: { harness: next.harness, sessionId: next.sessionId } } : {}),
    };
  };

  /**
   * A turn that exited CLEAN but wrote nothing to the log - no new version, no
   * reply, no question. Usually it decided there was nothing to do ("that
   * annotation is marked as a test, so I left it untouched"), and it said so
   * on stdout, where only a log file can see it.
   *
   * Without this the panel holds "picked up your feedback · no response yet"
   * forever on a turn that finished and answered: the agent's own words go in
   * as its reply, so the loop closes where the human is looking.
   */
  const reportSilentTurn = async (through: number, outputFrom: number): Promise<void> => {
    // Anything the turn itself recorded is a better answer than its stdout.
    // OUTPUT events only: the delivery ack is ours, written before the turn
    // even started, and counting it made every turn look like it had spoken.
    const events = (await readEvents(paths.logPath)).events;
    const spoke = events.some(
      (e) => e.seq > through && (e.t === "version" || e.t === "agent_reply" || e.t === "question"),
    );
    if (spoke) return;
    // THIS run's bytes only: the attend log accumulates runs, and scanning the
    // whole file let a run with no recognizable footer relay an EARLIER run's
    // final message - plus everything after it - as this turn's words.
    const output = (await readFile(paths.attendLog, "utf8").catch(() => "")).slice(outputFrom);
    // The harness's final message when the output framing is known (codex),
    // else the narration-filtered tail - see relayableReply for why a raw
    // byte slice of the log is not something to put in the human's transcript.
    const tail = relayableReply(output);
    if (tail === "") return;
    await deliver(paths, {
      t: "agent_reply",
      id: crypto.randomUUID(),
      text: tail,
    }).catch(() => {
      /* the turn already succeeded; relaying its words is best-effort */
    });
    log(`attend ${paths.name}: the turn changed nothing and said so - relayed its reply`);
  };

  /**
   * The highest delivery mark that was FOLLOWED by agent output - a batch some
   * turn actually answered, rather than one a turn merely claimed.
   *
   * Delivery is acked before the turn runs (D20), so an ack alone proves nothing
   * about whether the work happened. This is what a stale claim rolls back to.
   */
  const answeredMark = (events: readonly LogEvent[]): number => {
    let openMark: number | undefined;
    let answered = 0;
    for (const e of events) {
      if (e.t === "agent_ack") {
        openMark = (e as { covers?: number }).covers ?? openMark;
        continue;
      }
      if (e.t === "version" || e.t === "agent_reply" || e.t === "question") {
        if (openMark !== undefined) answered = Math.max(answered, openMark);
        openMark = undefined;
      }
    }
    return answered;
  };

  /** Drive one revise turn for everything pending up to `state.highSeq`. */
  const driveTurn = async (state: FoldedState, deliveredFrom: number): Promise<void> => {
    // The artifact's LATEST identified harness session: the association to
    // resume (D10 - resume is per session id, from its own cwd).
    const record = await attendTarget(state);
    if (!record) {
      unattendable("no harness session recorded on this artifact");
      return;
    }
    const registry = await loadRegistry(options.harnessesPath);
    const selection = await readSelection(paths);
    const switchesHarness =
      selection?.harness !== undefined &&
      normalizeHarness(selection.harness) !== normalizeHarness(record.harness);
    const priorCwd = await usableCwd(record.cwd, paths.artifactDir);
    const priorProjectCwd = projectRootOf(priorCwd) ?? priorCwd;
    const projectCwd = artifactProjectCwd(paths);
    // Fresh when the harness switches, the artifact moved projects, or no
    // PROVEN resumable session exists - a handoff resumes nothing, so it
    // needs no candidate.
    const startsFresh =
      switchesHarness ||
      record.sessionId === undefined ||
      resolve(priorProjectCwd) !== resolve(projectCwd);
    const wantedHarness = switchesHarness ? selection.harness : record.harness;
    const resolved = registry ? resolveRecipe(registry, wantedHarness) : undefined;
    if (!resolved) {
      unattendable(`no spawn recipe for harness "${wantedHarness}"`);
      return;
    }
    // Exact match only, unlike a fork: resuming session id X means re-entering
    // ONE harness's conversation, so the registry default is not a stand-in
    // for the harness that actually recorded it.
    // Normalized: `claude_code` in the registry IS `claude-code` on the
    // artifact. Still exact in every other sense - resuming session id X means
    // re-entering ONE harness's conversation, never the registry default.
    if (normalizeHarness(resolved.name) !== normalizeHarness(wantedHarness)) {
      unattendable(`harness "${wantedHarness}" is not in the registry`);
      return;
    }
    const recipeTemplate = startsFresh ? resolved.recipe.spawn : resolved.recipe.resume;
    if (!recipeTemplate) {
      unattendable(`recipe "${resolved.name}" has no ${startsFresh ? "spawn" : "resume"} argv`);
      return;
    }

    const target = state.highSeq;
    if (target !== attemptedBatchSeq) {
      attemptedBatchSeq = target;
      attemptedForBatch = new Set<string>();
    }
    // The id THIS attempt resumes: the primary, or - after a not-found
    // quarantined it - the one permitted fallback. Both spent means the
    // artifact's identity evidence is exhausted for this batch: say so once,
    // keep the feedback undelivered (the cursor does not move), stand down.
    const resumeTargetId = startsFresh
      ? undefined
      : [record.sessionId, record.fallback?.sessionId].find(
          (id): id is string => id !== undefined && !attemptedForBatch.has(id),
        );
    if (!startsFresh && resumeTargetId === undefined) {
      pauseFor(ATTEND_COOLOFF_MS, resolved.name);
      options.warn?.(
        "HARNESS_SESSION_UNAVAILABLE",
        "The recorded harness session cannot be resumed on this machine; feedback stays recorded until a session is re-established.",
      );
      log(`attend ${paths.name}: no resumable session candidate remains for this batch`);
      return;
    }
    const payload = await assemblePayload(paths, state, "feedback", {
      annotations: state.annotations.filter((a) => a.seq > deliveredFrom),
      messages: state.messages.filter((m) => m.role === "human" && m.seq > deliveredFrom),
      reverts: state.reverts.filter((r) => r.seq > deliveredFrom),
      questions: state.questions.filter(
        (q) => q.answerSeq !== undefined && q.answerSeq > deliveredFrom,
      ),
      // Forks spin off a NEW artifact; that is the launcher's job, never a
      // revise turn on this one.
      forks: [],
    });
    const revision = revisePrompt(payload, paths.artifactPath);
    if (revision === null) {
      // Pending, but nothing an agent can act on (a skipped question). Consume
      // it rather than re-deciding on it every poll.
      deliveredUpTo = target;
      firstPendingAt = undefined;
      return;
    }

    // A resume stays in the established session's cwd (D10). A fresh handoff
    // starts from the artifact's current project, so a sandboxed target can
    // write the artifact after it moved between projects.
    const cwd = startsFresh ? projectCwd : priorCwd;
    const strategy = resolved.recipe.sessionIdentity;
    // A fresh handoff to a DISCOVERED harness assigns nothing - the harness
    // mints its own id and announces it on stdout; a pre-minted UUID here is
    // exactly the synthetic identity that poisoned resume. Caller-assigned
    // (and legacy) handoffs keep minting; a resume always names the recorded
    // session.
    const sessionId = startsFresh
      ? strategy?.source === "stdout-jsonl"
        ? undefined
        : crypto.randomUUID()
      : resumeTargetId;
    if (!startsFresh && sessionId) attemptedForBatch.add(sessionId);
    const prompt = startsFresh
      ? [
          "You are continuing an existing Lucid review in a new harness session.",
          `Read the full Lucid review record at ${paths.logPath}.`,
          `Read the current artifact at ${paths.artifactPath}.`,
          "The record is the complete shared transcript: human feedback, agent replies, questions, answers, and artifact versions.",
          "Continue from that shared context, then handle the pending feedback below.",
          revision,
        ].join("\n")
      : revision;
    // The artifact's sticky model/effort: read before EVERY resume, so a
    // change takes effect on the next turn without remounting the session.
    // Re-validated every time too - the registry is a file a human edits, and
    // a pick it no longer offers must not reach the CLI as a dead flag.
    const applied = await applicableSelection(resolved.name, resolved.recipe);
    const argv = insertSelectionArgs(
      resolved.name,
      buildArgv(
        recipeTemplate,
        {
          id: sessionId ?? "",
          artifact: paths.artifactPath,
          cwd,
          prompt,
        },
        resolved.recipe.tools,
      ),
      applied.args,
      recipeTemplate,
    );
    await mkdir(paths.sessionDir, { recursive: true });
    // Last look before the process exists: everything above awaited, and an
    // interactive attendant that connected meanwhile owns this batch. The
    // cursor stays put, so the human's feedback is theirs to take.
    if (options.agentsListening() > 0) return;
    // Record the delivery before making it (D20): the panel says "delivered"
    // for the whole headless turn instead of "recorded", and a second watcher
    // reading the log sees the batch is taken.
    ownClaimSeq = target;
    // The turn this delivery IS (plan 08, D-013). Minted before the ack that
    // OPENS its window, so the terminator appended after the process exits
    // closes the same turn. The child inherits it via LUCID_TURN_ID, so the
    // turn's own acks join it too - a turn nobody can name is one nobody can
    // end.
    const turnId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await deliver(paths, {
      t: "agent_ack",
      id: crypto.randomUUID(),
      // NO intent. Not because the hub is blind - it is the party ORDERING a
      // revision, in this function, and it refuses to spawn at all when the
      // batch gives `revisePrompt` nothing to act on. It is because an order
      // is not an outcome: the turn is what decides whether an edit actually
      // follows, and "hey" produces a prompt the agent correctly declines. So
      // the ack states the delivery it made and nothing about the output;
      // `revisePrompt` tells the turn to declare that itself (`lucid intent`),
      // and until it does the viewer says "Agent responding…", which is true
      // of every running turn.
      covers: target,
      turnId,
      // The artifact's own session (D18): the hub acts on its behalf, and the
      // events the turn writes must not be attributed to the hub.
      // A handoff is not a session until its spawn succeeds or the child writes
      // its own provenance. Stamping the target here made a pre-session failure
      // look resumable on retry, so handoff delivery remains unattributed until
      // the process establishes that session.
      ...(!startsFresh ? { attendant: { harness: resolved.name, sessionId, cwd } } : {}),
    }).catch(() => {
      /* presence is advisory; a failed ack must not cancel the delivery */
    });
    log(
      `attend ${paths.name}: delivering feedback via "${resolved.name}" ${startsFresh ? "handoff" : "resume"}`,
    );
    // Where this run's output will start in the shared attend log, so a
    // silent-turn relay reads THIS turn's words and never an earlier run's.
    const outputFrom = await stat(paths.attendLog).then(
      (s) => s.size,
      () => 0,
    );
    const launchId = mintLaunchId();
    const allowRotation = strategy?.source === "stdout-jsonl" && strategy.allowRotation === true;
    const result = await runSpawn(argv, cwd, paths.attendLog, {
      harness: resolved.name,
      ...(sessionId ? { sessionId } : {}),
      turnId,
      launchId,
      ...(strategy ? { strategy } : {}),
      // Persistence while the turn is LIVE, through the one guarded callback:
      // a resume that announces a STRANGER is refused (HSI005), never bound.
      onIdentityDiscovered: discoveryPersistence(
        paths,
        resolved.name,
        launchId,
        !startsFresh && sessionId ? { requestedSessionId: sessionId, allowRotation } : undefined,
      ),
      ...(options.hubPort !== undefined ? { hubPort: options.hubPort } : {}),
      // Only what the argv actually carries: a dropped stale pick must not
      // stamp the child as running a model it was never given.
      ...(applied.model !== undefined ? { model: applied.model } : {}),
      ...(applied.effort !== undefined ? { effort: applied.effort } : {}),
    });
    const code = result.code;
    if (result.status === "identity-missing") {
      // Same HSI002 parity as the create paths: the turn ran clean but
      // announced nothing, so whatever it did, THIS launch is not resumable.
      log(`attend ${paths.name}: turn announced no session identity (HSI002)`);
    }
    // Inspect THIS run before recording how it ended. The attend log appends
    // every attempt, so scanning the whole file could make an unrelated later
    // crash inherit an earlier turn's usage wall.
    const runOutput = (await readFile(paths.attendLog, "utf8").catch(() => "")).slice(outputFrom);
    const limit = code === 0 ? null : detectUsageLimit(runOutput);
    // Identity established by this turn. Fresh handoff: what the harness
    // ANNOUNCED wins; the legacy whole-output scan covers recipes that
    // predate declarations (retired with the registry migration); a clean
    // caller-assigned handoff established the id it was given. Resume: the
    // REQUESTED session stands - an announcement of the same id confirms it,
    // an allowed rotation adopts the new one, and a refused mismatch keeps
    // the requested id with the observed stranger left unbound (HSI005; the
    // recovery milestone surfaces it).
    const observedId = "identity" in result ? result.identity?.sessionId : undefined;
    const resumeOutcome =
      !startsFresh && sessionId && observedId
        ? classifyObservedIdentity(
            sessionId,
            { authority: "observed", harness: resolved.name, sessionId: observedId },
            allowRotation,
          )
        : undefined;
    const establishedSessionId = startsFresh
      ? (observedId ??
        spawnedSessionId(resolved.name, runOutput) ??
        (code === 0 ? sessionId : undefined))
      : resumeOutcome?.status === "rotated"
        ? observedId
        : sessionId;
    // Authority is a claim about HOW the id is known, so it never exceeds the
    // evidence: observed only for an announcement that was not refused,
    // assigned only for a caller-assigned handoff that ran clean - an id
    // recovered by scanning output text has no authority at all.
    const establishedAuthority =
      observedId !== undefined && resumeOutcome?.status !== "mismatch"
        ? "observed"
        : startsFresh && code === 0 && strategy?.source === "caller-assigned"
          ? "assigned"
          : undefined;
    // The turn stopped, whatever it produced. The hub holds the child, so it
    // is the authoritative witness - and without this a turn that read the
    // feedback and produced nothing left its window open forever (finding #1).
    // Advisory: it moves no cursor and wakes no waiter.
    await deliver(paths, {
      t: "agent_turn_ended",
      turnId,
      reason: code === 0 ? "done" : limit !== null ? "usage_limit" : "failed",
      // Event codes use the log's identifier charset; limit kinds use hyphens
      // on the warning wire. Both remain identifiers, never harness prose.
      ...(limit !== null ? { code: limit.replaceAll("-", "_") } : {}),
      ...(establishedSessionId
        ? {
            attendant: {
              harness: resolved.name,
              sessionId: establishedSessionId,
              cwd,
              launchId,
              ...(establishedAuthority && strategy
                ? { sessionIdAuthority: establishedAuthority }
                : {}),
            },
          }
        : {}),
    }).catch(() => {
      // The turn is over regardless; a failed append is not worth retrying
      // into a loop. The stale state still covers the viewer.
    });

    if (resumeOutcome?.status === "mismatch") {
      // HSI005: the harness answered with a DIFFERENT conversation. Binding it
      // was already refused in discovery; here the batch stops cold - no
      // invalidation (the requested id may be fine elsewhere), no fallback (a
      // second candidate cannot fix a harness that rotates), no cursor
      // advance (the feedback stays the human's, undelivered), whatever the
      // exit code claims.
      pauseFor(ATTEND_COOLOFF_MS, resolved.name);
      options.warn?.(
        "HARNESS_SESSION_MISMATCH",
        "The harness resumed a different conversation than the one recorded; delivery stopped so feedback cannot land in a stranger's session.",
      );
      log(
        `attend ${paths.name}: resume announced a different session than requested (HSI005); delivery stopped`,
      );
      return;
    }
    if (code === 0) {
      // Advance only on a clean turn, so a failed one retries the batch
      // instead of silently swallowing the human's feedback.
      deliveredUpTo = target;
      firstPendingAt = undefined;
      fails = 0;
      await reportSilentTurn(target, outputFrom);
      return;
    }
    // A native-session-not-found is a VERDICT, not a flake (HSI004): the
    // adapter's own classifier recognized it, so the id is quarantined on
    // this machine - durably, across restarts - and the transient retry
    // ladder is bypassed. The next tick tries the one permitted fallback;
    // exhaustion is announced at selection time, above.
    const notFound =
      !startsFresh && sessionId && limit === null
        ? classifySessionFailure(resolved.name, runOutput)
        : null;
    if (notFound === "HSI004") {
      await recordSessionInvalidation(paths, resolved.name, sessionId as string).catch(() => {});
      log(
        `attend ${paths.name}: harness says session ${sessionId} does not exist here (HSI004); quarantined`,
      );
      return;
    }
    fails += 1;
    // A usage-limited harness is a WALL, not a flake: retrying burns nothing
    // but time, and the human sees feedback stuck at "recorded" with no clue
    // why. Name it in the viewer and stand down for the cool-off at once.
    if (limit !== null) {
      fails = 0;
      pauseFor(ATTEND_COOLOFF_MS, resolved.name);
      // The turn-ended event above is durable chat state. Do not also broadcast
      // a transient warning below the conversation: two treatments of the same
      // wall made the one useful explanation look like two failures.
      log(`attend ${paths.name}: delivery paused - harness limit (${limit})`);
      return;
    }
    if (fails >= MAX_ATTEND_FAILS) {
      fails = 0;
      pauseFor(ATTEND_COOLOFF_MS, resolved.name);
      log(
        `attend ${paths.name}: resume failed ${MAX_ATTEND_FAILS}x (exit ${code}); pausing attendance for ${ATTEND_COOLOFF_MS / 60000} minutes - see ${paths.attendLog}`,
      );
      options.warn?.(
        "ATTEND_DELIVERY_FAILED",
        `Delivery failed ${MAX_ATTEND_FAILS}x and is paused - see .lucid/${paths.name}/attend.out.log`,
      );
      return;
    }
    // A POINTER to the harness's own last words, not the words themselves:
    // this line now lands in the retained hub log (D-009), and a failed
    // turn's final output can be reply text - review content the log must
    // never hold (R1). The named file keeps the one-line diagnosis one
    // step away instead of a hunt.
    log(
      `attend ${paths.name}: resume exited ${code} (attempt ${fails}); will retry the batch - last output: ${paths.attendLog}`,
    );
  };

  /** Log identity, or undefined when it cannot be read right now. */
  const logStamp = async (): Promise<string | undefined> =>
    stat(paths.logPath).then(
      (s) => `${s.mtimeMs}:${s.size}`,
      () => undefined,
    );

  const evaluate = async (now: number): Promise<void> => {
    // Cheap gate first. Nothing can change without the log changing, and an
    // idle artifact re-folding its whole log once a second per mount is the
    // common case. A clocked batch keeps evaluating: the debounce elapses on
    // the clock, not on a write.
    const stamp = await logStamp();
    if (
      stamp !== undefined &&
      stamp === lastLogStamp &&
      firstPendingAt === undefined &&
      unfulfilledClaimAt === undefined
    ) {
      return;
    }

    let events: readonly LogEvent[];
    try {
      events = (await readEvents(paths.logPath)).events;
    } catch {
      return; // unreadable right now; the next pass retries
    }
    if (stamp !== undefined) lastLogStamp = stamp;
    const state = foldLog(events);
    if (state.status === "ended") {
      stopped = true;
      return;
    }
    // First pass: adopt the log's OWN delivered cursor - the last batch an
    // agent acked - not the current high seq.
    //
    // High seq meant "everything already in the log is someone else's problem",
    // which silently swallowed the one case attend mode exists for: feedback
    // sent while nothing was mounted (the hub restarted, the tab was closed,
    // the artifact was dormant). The human saw it sit at "recorded" forever
    // with no turn, no error, and nothing in the log to explain why.
    //
    // Un-acked is un-delivered, by the same definition the panel displays, so
    // this drives it once - as ONE batched turn - and then advances normally.
    if (deliveredUpTo === undefined) {
      // Adopt the log's OWN delivered mark - the last batch an agent acked -
      // not the current high seq. High seq meant "everything already in the
      // log is someone else's problem", which silently swallowed the one case
      // attend mode exists for: feedback sent while nothing was mounted (the
      // hub restarted, the tab was closed, the artifact was dormant). The
      // human saw it sit at "recorded" forever with no turn and no error.
      deliveredUpTo = state.deliveredThroughSeq;
    }

    // A claim nobody honoured. Delivery is recorded BEFORE the turn runs (D20),
    // so a turn that then died - a crashed agent, a hub killed mid-turn, a
    // resume that exited non-zero and was never retried - leaves an ack
    // covering feedback nothing acted on, and the human's message sits marked
    // "delivered" forever. An open working window (ack, no agent output since)
    // older than the grace is that state, by the same staleness rule
    // attendDecision uses for a live one.
    //
    // Checked every pass, not just the first: a claim usually goes stale while
    // the hub is UP, minutes after the watcher started.
    const ackAt = lastAckAt(events);
    unfulfilledClaimAt = state.agentWorking !== null ? ackAt : undefined;
    if (
      unfulfilledClaimAt !== undefined &&
      now - unfulfilledClaimAt > workingGraceMs &&
      !inFlight &&
      ownClaimSeq !== state.deliveredThroughSeq &&
      deliveredUpTo === state.deliveredThroughSeq
    ) {
      // The last batch that was actually ANSWERED - not simply the previous
      // ack. Retrying the same batch writes another ack covering the same
      // seqs, so "the ack before this one" converged on the current mark and
      // the rollback below could never fire: fifteen failed turns, fifteen
      // acks, and feedback pinned at "delivered" that nothing had read.
      const priorMark = answeredMark(events);
      if (priorMark < deliveredUpTo) {
        log(`attend ${paths.name}: a delivery claim went unanswered - re-driving that batch`);
        deliveredUpTo = priorMark;
        // Disown it, or the "somebody else took this batch" rule below
        // re-adopts it from the very same log on this same pass.
        ownClaimSeq = state.deliveredThroughSeq;
        unfulfilledClaimAt = undefined;
      }
    }
    // Delivery SOMEBODY ELSE took: an interactive agent's ack names the batch
    // it read, so the hub steps aside rather than running the same turn again
    // in the gap after that agent's wait returns. Our own outstanding claim is
    // excluded - its turn is still being judged by its exit code.
    if (state.deliveredThroughSeq > deliveredUpTo && state.deliveredThroughSeq !== ownClaimSeq) {
      deliveredUpTo = state.deliveredThroughSeq;
      firstPendingAt = undefined;
    }
    const pendingFeedbackSeqs = pendingHumanSeqs(events, deliveredUpTo);
    firstPendingAt = pendingFeedbackSeqs.length === 0 ? undefined : (firstPendingAt ?? now);
    // A working window OUR OWN dead turn opened must not gate the retry. The
    // window exists to keep the hub out while somebody else edits; when the
    // claim is ours and the process has already exited, there is nobody to
    // stay out of the way of - and waiting the full grace on ourselves turned
    // every failed turn into ten minutes of silence, which is what made this
    // look like nothing was happening at all.
    const ourDeadClaim =
      !inFlight && ownClaimSeq !== 0 && state.deliveredThroughSeq === ownClaimSeq;
    const verdict = attendReason({
      pendingFeedbackSeqs,
      listening: options.agentsListening(),
      workingSince: state.agentWorking && !ourDeadClaim ? lastAckAt(events) : undefined,
      firstPendingAt,
      now,
      inFlight,
      debounceMs,
      workingGraceMs,
    });
    // "Why did this turn not run" had no answer before M3.1 - every pass that
    // declined was indistinguishable from a poll that never happened. Silent
    // unless LUCID_VERBOSE names `attend`.
    trace(() => `${paths.name}: ${verdict.decision} - ${verdict.reason}`);
    if (verdict.decision !== "spawn") return;
    // The human is IN that conversation right now. Resuming it headlessly
    // would put two processes on one harness session - the hub typing into a
    // window somebody is sitting at. `listening` cannot see this: a human
    // mid-thought has no agent blocked in `wait`.
    //
    // Deliberately not a "wait" from attendDecision: that function is pure and
    // this is a filesystem question, and the answer can change between polls.
    // The feedback stays pending and is delivered the moment that terminal
    // closes - or by the agent in it, which is the better outcome anyway.
    // Asked of the SAME record driveTurn would resume, so the question is
    // exactly "is the thing I am about to resume already open?", never a
    // near-miss on some other stamp.
    const live = await presenceFor(await attendTarget(state), paths.artifactDir);
    if (live?.interactive) return;
    // Claim the turn HERE, with no await between the decision and the flag:
    // driveTurn's own awaits (registry, payload, spawn) would otherwise let a
    // second poll decide "spawn" on the same batch and run a duplicate agent.
    inFlight = true;
    try {
      await driveTurn(state, deliveredUpTo);
    } finally {
      inFlight = false;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = Date.now();
    if (now < pausedUntil) {
      const selection = await readSelection(paths);
      if (
        !pausedHarness ||
        !selection?.harness ||
        normalizeHarness(selection.harness) === normalizeHarness(pausedHarness)
      ) {
        return;
      }
      pausedUntil = 0;
      pausedHarness = undefined;
    }
    try {
      await evaluate(now);
    } catch (err) {
      // Everything from a malformed harness registry to a payload that cannot
      // be assembled surfaces here. Escaping a timer as an unhandled rejection
      // would repeat once per poll for the hub's lifetime and can take the
      // process down with it.
      noteFailure((err as Error).message);
    }
  };

  return {
    tick,
    stop: () => {
      stopped = true;
    },
  };
};

/** The create-from-nothing instruction (D3/D16): author the artifact, then put
 *  it in front of the human. The human's request rides as data, and every value
 *  reaches the harness as argv - nothing is ever shell-interpolated. The one
 *  command line inside the prompt is quoted for the shell the AGENT will run it
 *  in, which is the only shell in this path. */
export const createArtifactPrompt = (artifact: string, request: string, title?: string): string =>
  [
    "You are authoring a new Lucid artifact for human review.",
    `Write a single self-contained HTML document to exactly ${artifact}.`,
    // The human named the document; the shell shows that name on its tab by
    // reading the artifact's own <title>, so the agent must not retitle it.
    ...(title
      ? [`Its <title> must be exactly: ${title}`, "Use that as the document's heading too."]
      : []),
    "It must answer this request from the human:",
    request,
    // The one flow Lucid itself commissions a document in, so it says the
    // house rules outright rather than trusting the skill to trigger: an
    // artifact is read as paper, and a SCREEN is reviewed as a wireframe
    // (labelled regions, hatched placeholders) until someone asks for a
    // finished design.
    "Follow the lucid-design skill if it is available. Otherwise: a warm cream",
    "ground with near-black type, one accent, and no external requests. Every",
    "picture - diagram, flow, chart, timeline, screen - is built from real",
    "elements or inline SVG, never ASCII or box-drawing characters, so a",
    "reviewer can annotate one part of it. A mockup of a screen is a WIREFRAME",
    "(labelled regions, hatched placeholders carrying their spec), not finished",
    "visual design, unless the request asks for a specific design.",
    // Prose is half of what gets marked up, so the writing bar is stated here
    // beside the visual one rather than left to the skill. Orwell's rules,
    // compressed: a reviewer pays attention for every word before the claim.
    "Write to Orwell's six rules: no figure of speech you are used to seeing in",
    "print; no long word where a short one will do; cut every word that can go;",
    "active voice over passive; an everyday English word over a jargon or",
    "foreign one; and break any of these sooner than write something barbarous.",
    // The same narration channel a revise turn uses (revisePrompt): only the
    // turn knows its phase, and the create dialog is otherwise a bare clock
    // for however many minutes authoring takes. Works before `lucid open` -
    // the CLI appends straight to the log when no server answers, and the
    // hub's heartbeat reads the newest label from there.
    `As you work, report each phase as you enter it: \`lucid progress ${shellArg(artifact)} --label "<what you are doing, in a few words>"\` - for example "planning the sections", "writing the comparison table", "final read-through". The human watches these one-liners while they wait.`,
    "Then open it for review by running:",
    `  lucid open ${shellArg(artifact)}`,
    `Write only ${artifact}; do not modify other files.`,
  ].join("\n");
