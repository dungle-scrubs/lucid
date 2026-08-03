import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tracer } from "../core/verbose.ts";
import {
  artifactAttendant,
  readAttendantSidecars,
  recordSessionInvalidation,
  resolveResumeCandidates,
  type ResumeCandidate,
} from "../core/attendant.ts";
import { deliver } from "../core/deliver.ts";
import type { LogEvent, LogEventType } from "../core/events.ts";
import { foldLog, type FoldedState } from "../core/fold.ts";
import { readEvents } from "../core/log.ts";
import type { SessionPaths } from "../core/paths.ts";
import { artifactCheckout, checkoutOf, projectOf } from "../core/project.ts";
import { assemblePayload } from "../core/payload.ts";
import {
  harnessHasLocalStore,
  harnessSessionCwd,
  harnessSessionId,
  harnessStoreHas,
  harnessSupportsPresence,
  harnessTranscriptPath,
  livePresenceCached,
  presenceFor,
  presenceStoreReadable,
} from "../core/presence.ts";
import { scratchpadProject } from "../core/scratchpad.ts";
import { revisePrompt } from "../launch/prompts.ts";
import {
  DEFAULT_TURN_IDLE_MS,
  planTurn,
  readRunOutput,
  runTurn,
  type TurnOutcome,
} from "../launch/turn.ts";
import {
  loadRegistry,
  normalizeHarness,
  registryPath as harnessRegistryPath,
  resolveExactRecipe,
} from "../launch/recipes.ts";
import { readSelection } from "../launch/selection.ts";

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

/** How old an open working window must be before the startup sweep may close
 *  it as orphaned. A child the PREVIOUS hub spawned moments before dying
 *  needs time to register its presence file; a genuinely orphaned window is
 *  minutes old, not seconds. */
const DEFAULT_ORPHAN_MIN_AGE_MS = 30_000;

/** Native session ids with a resume IN FLIGHT anywhere in this process,
 *  mapped to the claiming TURN. Two artifacts can legitimately share one
 *  harness session (an agent that split a document declares its session on
 *  both halves) - but two concurrent `--resume` processes on one session are
 *  two writers appending a single transcript. Each drive claims the id for
 *  the duration of its spawn; any other claimant's batch simply waits for
 *  the next poll. Keyed by turn id, never artifact name: a remounted
 *  attendant for the SAME artifact must queue behind the child its evicted
 *  predecessor left running, and two artifacts can share a filename. */
const sessionsInFlight = new Map<string, string>();

/** Tests only: a leaked claim in one test must not silence the next. */
export const resetSessionsInFlight = (): void => {
  sessionsInFlight.clear();
};

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
  /** How long a spawned turn may write nothing before it is killed as wedged
   *  (tests inject a short one; the default is minutes). */
  readonly stallIdleMs?: number;
  /** How long attendance pauses after repeated or structural failures (tests
   *  inject a short one; the default is minutes). */
  readonly cooloffMs?: number;
  /** How old an open working window must be before the startup sweep may
   *  close it as orphaned (tests inject; the default is seconds). */
  readonly orphanMinAgeMs?: number;
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
  const cooloffMs = options.cooloffMs ?? ATTEND_COOLOFF_MS;
  const orphanMinAgeMs = options.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS;

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
  /** The orphan sweep has run for this mount. Once: orphans are what a DEAD
   *  hub leaves behind, so they can only exist when a watcher starts. */
  let sweptOrphans = false;
  /** The last selection-rejection already warned about, so a standing stale
   *  pick warns once instead of on every turn - but a NEW reason still does. */
  let saidSelectionInvalid = "";
  /** Native ids RULED OUT for the current undelivered batch (D-004): a
   *  harness not-found verdict (HSI004) retires an id, and at most one
   *  distinct weaker candidate is tried after it before the engine stands
   *  down. Only a verdict retires an id - a transient failure keeps the
   *  ordinary retry ladder on the same session, because the transport broke,
   *  not the conversation.
   *
   *  Keyed by the DELIVERED boundary, not by highSeq: the engine's own ack
   *  and turn-ended events raise highSeq on every attempt, so keying on it
   *  wiped the set each pass and the fallback could never be reached. The
   *  boundary moves only when a turn actually delivers - exactly when a new
   *  batch begins.
   *
   *  Time-bounded as well as batch-bounded (id -> ruled out at). A batch with
   *  ONE candidate never delivers, so its boundary never moves - and a
   *  rule-out that only a delivery could clear would be permanent there. The
   *  verdicts behind these entries are not all final either: a pre-flight
   *  "no transcript" can be a transient store-read failure, a stall a
   *  transient wedge. An entry older than the cooloff expires and the verdict
   *  is re-tested; only the on-disk HSI004 quarantine is durable. */
  let ruledOutForBatch = new Map<string, number>();
  let ruledOutBatchFrom = -1;
  const ruledOut = (id: string): boolean => {
    const at = ruledOutForBatch.get(id);
    if (at === undefined) return false;
    if (Date.now() - at < cooloffMs) return true;
    ruledOutForBatch.delete(id);
    return false;
  };

  const pauseFor = (ms: number, harness?: string): void => {
    pausedUntil = Date.now() + ms;
    pausedHarness = harness;
  };

  const unattendable = (reason: string): void => {
    // Back off as well as saying so: without a pause this verdict is re-derived
    // (and the registry re-read) on every poll for as long as the mount lives.
    pauseFor(cooloffMs);
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
    pauseFor(cooloffMs);
    log(`attend ${paths.name}: pausing attendance for ${cooloffMs / 60000} minutes`);
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
  const attendCandidates = async (
    state: FoldedState,
    legacy: Awaited<ReturnType<typeof artifactAttendant>>,
  ): Promise<readonly ResumeCandidate[]> => {
    const sidecars = await readAttendantSidecars(paths);
    const scratchpadId = harnessSessionId({ artifactDir: paths.artifactDir });
    // The recorded resume COMMAND comes from the sidecars directly, not from
    // `artifactAttendant`: that resolver answers "who owns this artifact" and
    // returns early on a stamped id, carrying no resume string - so reading
    // the command through it made tier 3 vanish for exactly the artifacts
    // that followed the integration guide most completely (export an id AND
    // record a resume command). Newest sidecar that has one wins.
    const recorded = [...sidecars]
      .filter((a) => a.resume !== undefined)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
    const harnessForScratchpad = recorded?.harness ?? legacy?.harness;
    return resolveResumeCandidates({
      sidecars,
      bindings: state.bindings,
      corroborate: (harness, sessionId) => harnessStoreHas(harness, sessionId),
      ...(recorded?.resume
        ? { legacyResume: { command: recorded.resume, harness: recorded.harness } }
        : {}),
      ...(scratchpadId && harnessForScratchpad
        ? { scratchpad: { harness: harnessForScratchpad, sessionId: scratchpadId } }
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
        /** Every candidate this artifact had was proven dead on this machine:
         *  a fresh handoff would answer a question nobody asked. */
        readonly exhausted?: boolean;
      }
    | undefined
  > => {
    // ONE read of the recorded association, shared by ranking (it supplies
    // the legacy resume command and the harness a scratchpad id belongs to)
    // and by placement (its cwd decides fresh-vs-resume).
    const recorded = await artifactAttendant(paths, state.sessionHistory);
    const candidates = await attendCandidates(state, recorded);
    const best = candidates[0];
    if (!best) {
      // No id survives the trust ladder. Two very different situations hide
      // here, and collapsing them was how the unavailable warning became
      // unreachable: an artifact that never had a resumable session (a fresh
      // handoff is right) versus one whose sessions this machine has PROVEN
      // dead (quarantined) - where silently starting a stranger is the
      // opposite of what the human is owed.
      if (!recorded?.harness) return undefined;
      const quarantined = (await readAttendantSidecars(paths)).some(
        (a) => (a.invalidatedSessionIds ?? []).length > 0,
      );
      return {
        harness: recorded.harness,
        ...(quarantined ? { exhausted: true } : {}),
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
    const output = await readRunOutput(paths.attendLog, outputFrom);
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
    // A fresh harness owns the artifact, not the source harness's old checkout,
    // and it may be sandboxed to its cwd - so it starts in the checkout the
    // artifact SITS in, the one directory guaranteed both to exist and to
    // contain the file the turn is asked to rewrite.
    const artifactCwd = artifactCheckout(paths);
    // The checkout the artifact BELONGS to, from the one owner of that
    // question. Through `projectOf` because the same artifact must not be
    // grouped under one project by the hub and treated as belonging to another
    // here: a scratchpad artifact belongs to the checkout its path encodes,
    // which is the very cwd its conversation ran in.
    //
    // Checked, because a decoded checkout is a NAME, not a live directory: an
    // ephemeral worktree is deleted once its work lands while the review
    // outlives it, and naming the work is right for a listing heading but
    // fatal as a comparand - a dead checkout would say "moved" about an
    // artifact that never went anywhere.
    const artifactProject = await usableCwd((await projectOf(paths)).checkout, artifactCwd);
    // Fresh when the harness switches, the artifact moved projects, or no
    // PROVEN resumable session exists - a handoff resumes nothing, so it
    // needs no candidate. Both sides of "moved" are normalized the same way:
    // an agent working in `<repo>/packages/app` has not left `<repo>`.
    const startsFresh =
      switchesHarness ||
      record.sessionId === undefined ||
      resolve(checkoutOf(priorCwd)) !== resolve(checkoutOf(artifactProject));
    const wantedHarness = switchesHarness ? selection.harness : record.harness;
    // Exact, unlike a fork: resuming session id X means re-entering ONE
    // harness's conversation, so the registry default is not a stand-in for
    // the harness that actually recorded it.
    const resolved = registry ? resolveExactRecipe(registry, wantedHarness) : undefined;
    if (!resolved) {
      unattendable(`no spawn recipe for harness "${wantedHarness}"`);
      return;
    }
    const recipeTemplate = startsFresh ? resolved.recipe.spawn : resolved.recipe.resume;
    if (!recipeTemplate) {
      unattendable(`recipe "${resolved.name}" has no ${startsFresh ? "spawn" : "resume"} argv`);
      return;
    }

    const target = state.highSeq;
    if (deliveredFrom !== ruledOutBatchFrom) {
      ruledOutBatchFrom = deliveredFrom;
      ruledOutForBatch = new Map<string, number>();
    }
    // The id THIS attempt resumes: the primary, or - after a not-found
    // quarantined it - the one permitted fallback. Both spent means the
    // artifact's identity evidence is exhausted for this batch: say so once,
    // keep the feedback undelivered (the cursor does not move), stand down.
    const resumeTargetId = startsFresh
      ? undefined
      : [record.sessionId, record.fallback?.sessionId].find(
          (id): id is string => id !== undefined && !ruledOut(id),
        );
    if (record.exhausted === true) {
      // Say it, then stand down: the recorded sessions are gone, and the
      // human decides whether to switch harness or attend it themselves.
      pauseFor(cooloffMs, resolved.name);
      options.warn?.(
        "HARNESS_SESSION_UNAVAILABLE",
        "The recorded harness session no longer exists on this machine; feedback stays recorded until a session is re-established.",
      );
      log(`attend ${paths.name}: every recorded session is quarantined here; standing down`);
      return;
    }
    if (!startsFresh && resumeTargetId === undefined) {
      pauseFor(cooloffMs, resolved.name);
      options.warn?.(
        "HARNESS_SESSION_UNAVAILABLE",
        "The recorded harness session cannot be resumed on this machine; feedback stays recorded until a session is re-established.",
      );
      log(`attend ${paths.name}: no resumable session candidate remains for this batch`);
      return;
    }
    // Pre-flight (the check the two-word error used to stand in for): the
    // transcript this resume needs either exists in the harness's local store
    // or the spawn is refused HERE, with the reason named, before a process
    // exists. A tier-one candidate is this machine's own sidecar record and
    // was never store-corroborated - which is exactly how a declared id whose
    // conversation lives elsewhere reached `--resume` argv and died as
    // "Execution error". The verdict expires with the cooloff (see ruledOut):
    // a "no" can be a transient store-read failure, and must not strand a
    // single-candidate artifact forever. ONE store walk serves two needs -
    // the path found here is also the activity signal the stall watchdog
    // reads while the turn runs.
    const transcript =
      !startsFresh && resumeTargetId !== undefined && harnessHasLocalStore(resolved.name)
        ? await harnessTranscriptPath(resolved.name, resumeTargetId)
        : undefined;
    if (
      !startsFresh &&
      resumeTargetId !== undefined &&
      harnessHasLocalStore(resolved.name) &&
      transcript === undefined
    ) {
      ruledOutForBatch.set(resumeTargetId, Date.now());
      options.warn?.(
        "HARNESS_SESSION_UNAVAILABLE",
        `Session ${resumeTargetId} has no local transcript for "${resolved.name}", so it cannot be resumed from this machine; trying the next candidate, if any.`,
      );
      log(
        `attend ${paths.name}: pre-flight refused resume of ${resumeTargetId} - no local "${resolved.name}" transcript`,
      );
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
    // starts from the artifact's own checkout, so a sandboxed target can write
    // the artifact after it moved between projects.
    const cwd = startsFresh ? artifactCwd : priorCwd;
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
    // What this turn actually runs as, from the one owner of that question
    // (src/launch/turn.ts): which template, under which identity, with the
    // artifact's sticky model/effort woven in. A HANDOFF is bound by the same
    // policy the create paths hold - a recipe declaring no identity strategy
    // is refused (HSI001) rather than handed a minted UUID nothing can resume.
    const planned = await planTurn({
      mode: startsFresh ? "handoff" : "resume",
      paths,
      harness: resolved.name,
      recipe: resolved.recipe,
      registryFile: options.harnessesPath ?? harnessRegistryPath(),
      ...(resumeTargetId !== undefined ? { sessionId: resumeTargetId } : {}),
      cwd,
      prompt,
    });
    if (planned.status === "refused") {
      unattendable(planned.reason);
      return;
    }
    // A stale pick DEGRADES: the turn runs on the CLI's own defaults and the
    // human is told why, because a stalled delivery is a worse failure than a
    // turn at the wrong effort. Warned once per standing reason - a NEW reason
    // still speaks, and a cleared pick makes the next one fresh again.
    if (planned.selectionIssue !== undefined) {
      log(`attend ${paths.name}: ${planned.selectionIssue}`);
      if (saidSelectionInvalid !== planned.selectionIssue) {
        saidSelectionInvalid = planned.selectionIssue;
        options.warn?.("SELECTION_INVALID", planned.selectionIssue);
      }
    } else {
      saidSelectionInvalid = "";
    }
    const { sessionId, turnId } = planned;
    await mkdir(paths.sessionDir, { recursive: true });
    // Last look before the process exists: everything above awaited, and an
    // interactive attendant that connected meanwhile owns this batch. The
    // cursor stays put, so the human's feedback is theirs to take.
    if (options.agentsListening() > 0) return;
    // One resume per native session at a time, PROCESS-wide: two artifacts
    // that share a session (an agent that split a document declares its
    // session on both) must take turns, or two `--resume` processes append
    // one transcript concurrently. No await sits between the check and the
    // claim, so the check is atomic; the loser leaves its batch for the next
    // poll, where the freed id is picked up. The turn id the owner minted is
    // the claim TOKEN, so a release can only ever free this drive's own claim.
    if (sessionId !== undefined) {
      if (sessionsInFlight.has(sessionId)) {
        trace(() => `${paths.name}: session ${sessionId} is mid-resume elsewhere; waiting`);
        return;
      }
      sessionsInFlight.set(sessionId, turnId);
    }
    // Record the delivery before making it (D20): the panel says "delivered"
    // for the whole headless turn instead of "recorded", and a second watcher
    // reading the log sees the batch is taken. The owner appends the ack, the
    // terminator, and everything between.
    ownClaimSeq = target;
    let outcome: TurnOutcome;
    try {
      outcome = await runTurn(planned, {
        outLog: paths.attendLog,
        covers: target,
        ...(options.hubPort !== undefined ? { hubPort: options.hubPort } : {}),
        // A wedged child holds this artifact: the engine reads a live child as a
        // delivery in flight, so every later note queues behind it in silence.
        // Bounded on SILENCE, never on duration - a turn writing anything at all
        // is working, however long it takes.
        //
        // What counts as alive, beyond the out-log: a RESUME watches the
        // harness transcript (resolved by pre-flight) - the one signal a
        // buffered-stdout CLI (`claude -p`) still moves during a long turn;
        // measuring the out-log alone killed every healthy claude-code turn
        // longer than the idle window, one of them seconds after it had
        // already replied. The artifact's own record is deliberately NOT
        // watched for a resume: anyone can append there, and a human
        // annotating while they wait would keep a genuinely wedged child
        // alive forever - the original 53-minute wedge, reborn. A fresh
        // handoff has no transcript to watch, so the record is the best
        // signal it has (its own `lucid open`/`progress` calls land there).
        deadline: {
          idleMs: options.stallIdleMs ?? DEFAULT_TURN_IDLE_MS,
          activityPaths: startsFresh
            ? [paths.logPath]
            : transcript !== undefined
              ? [transcript]
              : [],
        },
        onDelivered: () =>
          log(
            `attend ${paths.name}: delivering feedback via "${resolved.name}" ${startsFresh ? "handoff" : "resume"}`,
          ),
        // The claim ends with the PROCESS, not with this function: everything
        // after the child exits is classification of something that no longer
        // runs. Token match, so a claim another drive holds is never released.
        onSpawnSettled: () => {
          if (sessionId !== undefined && sessionsInFlight.get(sessionId) === turnId) {
            sessionsInFlight.delete(sessionId);
          }
        },
      });
    } finally {
      // Belt and braces for a failure BEFORE the child existed: a claim this
      // drive never released would silence every later turn on that session.
      if (sessionId !== undefined && sessionsInFlight.get(sessionId) === turnId) {
        sessionsInFlight.delete(sessionId);
      }
    }
    const code = outcome.code;
    if (outcome.result.status === "identity-missing") {
      // Same HSI002 parity as the create paths: the turn ran clean but
      // announced nothing, so whatever it did, THIS launch is not resumable.
      log(`attend ${paths.name}: turn announced no session identity (HSI002)`);
    }
    // THIS run's output only. The attend log appends every attempt, so
    // scanning the whole file could make an unrelated later crash inherit an
    // earlier turn's usage wall.
    const runOutput = outcome.output;
    const limit = outcome.failure?.usageLimit ?? null;

    if (outcome.identity?.status === "mismatch") {
      // HSI005: the harness answered with a DIFFERENT conversation. Binding it
      // was already refused in discovery; here the batch stops cold - no
      // invalidation (the requested id may be fine elsewhere), no fallback (a
      // second candidate cannot fix a harness that rotates), no cursor
      // advance (the feedback stays the human's, undelivered), whatever the
      // exit code claims.
      pauseFor(cooloffMs, resolved.name);
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
      await reportSilentTurn(target, outcome.outputFrom);
      return;
    }
    // A resume the parent had to KILL wrote nothing anywhere - not to its
    // out-log, not to the artifact's record, not to the harness transcript -
    // for the whole idle window: a wedged harness process, not bad feedback.
    // Resuming the same id again in this batch would likely wedge again, so
    // it is retired FOR THE BATCH (never durably - the conversation itself
    // may be fine) and the ladder falls to the fallback candidate or stands
    // down with the standing warning. Said out loud both times: silently
    // abandoning the bound session is the one thing the human has asked this
    // engine never to do.
    if (outcome.stalled && !startsFresh && sessionId) {
      ruledOutForBatch.set(sessionId, Date.now());
      options.warn?.(
        "ATTEND_RESUME_STALLED",
        `The resume of session ${sessionId} produced nothing and was stopped; it will not be retried for this batch.`,
      );
      log(
        `attend ${paths.name}: resume of ${sessionId} wrote nothing and was stopped; not resuming it again for this batch`,
      );
      return;
    }
    // A native-session-not-found is a VERDICT, not a flake (HSI004): the
    // adapter's own classifier recognized it, so the id is quarantined on
    // this machine - durably, across restarts - and the transient retry
    // ladder is bypassed. The next tick tries the one permitted fallback;
    // exhaustion is announced at selection time, above.
    if (outcome.sessionNotFound) {
      // Retired for this batch as well as quarantined on disk: the durable
      // record stops the id coming back after a restart, and this set is what
      // bounds the batch to one weaker candidate before standing down.
      ruledOutForBatch.set(sessionId as string, Date.now());
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
      pauseFor(cooloffMs, resolved.name);
      // The turn-ended event above is durable chat state. Do not also broadcast
      // a transient warning below the conversation: two treatments of the same
      // wall made the one useful explanation look like two failures.
      log(`attend ${paths.name}: delivery paused - harness limit (${limit})`);
      return;
    }
    if (fails >= MAX_ATTEND_FAILS) {
      fails = 0;
      pauseFor(cooloffMs, resolved.name);
      log(
        `attend ${paths.name}: resume failed ${MAX_ATTEND_FAILS}x (exit ${code}); pausing attendance for ${cooloffMs / 60000} minutes - see ${paths.attendLog}`,
      );
      // The harness's OWN last words ride the warning - "Execution error"
      // beats a bare failure count, and the human reading this panel is the
      // same human the turn's output belongs to. Bounded and
      // narration-stripped; the retained hub log above still carries only the
      // pointer (R1).
      const lastWords = relayableTail(runOutput).slice(-160).replace(/\s+/g, " ");
      options.warn?.(
        "ATTEND_DELIVERY_FAILED",
        `Delivery failed ${MAX_ATTEND_FAILS}x (exit ${code}${lastWords ? `: "${lastWords}"` : ""}); paused for ${cooloffMs / 60000} minutes, then retried - see .lucid/${paths.name}/attend.out.log`,
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
    // Startup sweep: close working windows whose owner is provably gone. A
    // hub killed mid-turn writes no terminator, so `agentWorking` survives it
    // - the panel reports an ancient ack as if it were live, and this engine
    // waits a full working-grace on a process that no longer exists. Only
    // windows whose harness publishes presence are judged, and only when this
    // machine's presence store is actually readable - an empty map from a
    // missing store proves nothing about any process, and absence is only
    // evidence where presence would show. A floor age keeps the sweep off
    // children a dying hub spawned moments earlier (their presence file may
    // not exist yet); a window skipped for age is revisited next tick rather
    // than latched past. The terminator names the turn, so an unrelated open
    // turn is untouched.
    if (!sweptOrphans && (await presenceStoreReadable())) {
      let closed = false;
      let closedClaimMax = 0;
      let skippedForAge = false;
      for (const open of state.openTurns) {
        if (now - Date.parse(open.heardAt) < orphanMinAgeMs) {
          skippedForAge = true;
          continue;
        }
        const acks = events.filter(
          (e): e is LogEvent & { readonly attendant?: { harness?: string; sessionId?: string } } =>
            e.t === "agent_ack" && (e as { turnId?: string }).turnId === open.turnId,
        );
        const owner = [...acks].reverse().find((a) => a.attendant)?.attendant;
        if (!owner?.harness || !owner.sessionId || !harnessSupportsPresence(owner.harness)) {
          continue;
        }
        if ((await livePresenceCached()).get(owner.sessionId) !== undefined) {
          continue;
        }
        await deliver(paths, {
          t: "agent_turn_ended",
          turnId: open.turnId,
          reason: "failed",
          code: "orphaned",
          attendant: { harness: owner.harness, sessionId: owner.sessionId },
        }).catch(() => {
          /* advisory; the grace-based staleness still covers a failed append */
        });
        log(
          `attend ${paths.name}: turn ${open.turnId} was orphaned by a restart (no live "${owner.harness}" process holds ${owner.sessionId}); closed its window`,
        );
        closed = true;
        for (const a of acks) {
          const covers = (a as { covers?: number }).covers;
          if (typeof covers === "number") closedClaimMax = Math.max(closedClaimMax, covers);
        }
      }
      if (!skippedForAge) sweptOrphans = true;
      if (closed) {
        // The orphan's ack was a delivery CLAIM nothing honoured. Closing the
        // window alone would leave that claim as the delivered mark, and this
        // watcher's first pass would adopt it - the batch marked delivered
        // forever, one step worse than the stale panel this sweep fixes. Roll
        // back to the last batch some turn actually ANSWERED, and disown the
        // SWEPT turns' claims - only theirs, so a surviving live turn's claim
        // is still adopted normally and its batch is never re-driven under
        // it. Reset the log stamp before returning: the terminator append is
        // best-effort, and a failed one must not leave the cheap gate
        // believing nothing changed. Then re-read - the fold in hand predates
        // the terminators.
        deliveredUpTo = answeredMark(events);
        ownClaimSeq = closedClaimMax;
        lastLogStamp = "";
        return;
      }
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
    // Asked of the artifact's RECORDED conversation, not of the resume
    // candidate: "is a human sitting in the session this artifact belongs to"
    // is an ownership question, and a mention that is deliberately unrankable
    // for resume still names a session somebody can be sitting in. Ranking it
    // here made the guard blind on exactly the artifacts whose evidence is a
    // bare stamp.
    const owner = await artifactAttendant(paths, state.sessionHistory);
    const live = await presenceFor(owner, paths.artifactDir);
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
