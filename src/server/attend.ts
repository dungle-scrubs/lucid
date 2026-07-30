import { mkdir, readFile, stat } from "node:fs/promises";
import { tracer } from "../core/verbose.ts";
import { artifactAttendant } from "../core/attendant.ts";
import { deliver } from "../core/deliver.ts";
import { shellArg } from "../core/escape.ts";
import type { LogEvent, LogEventType } from "../core/events.ts";
import { foldLog, type FoldedState } from "../core/fold.ts";
import { readEvents } from "../core/log.ts";
import type { SessionPaths } from "../core/paths.ts";
import { assemblePayload } from "../core/payload.ts";
import { harnessSessionCwd, harnessSessionId, presenceFor } from "../core/presence.ts";
import { scratchpadProject } from "../core/scratchpad.ts";
import { revisePrompt, runSpawn } from "../launch/launcher.ts";
import { detectUsageLimit } from "../launch/limits.ts";
import {
  buildArgv,
  loadRegistry,
  normalizeHarness,
  resolveRecipe,
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

/**
 * What of a quiet turn's output may be relayed to the human as the agent's
 * words. Lucid's OWN narration is not the agent's words: `LUCID_VERBOSE`
 * propagates into the spawned turn (it inherits the environment) and that
 * turn's stderr is the attend log this reads, so without the filter the tail
 * can be `[anchors] …` lines - delivered as an `agent_reply`, shown in the
 * viewer as something the agent said, and recorded permanently in log.ndjson.
 */
export const relayableTail = (output: string): string =>
  output
    .split("\n")
    .filter((line) => !/^\[(anchors|attend|verbose)\]/.test(line.trimStart()))
    .join("\n")
    .trim()
    .slice(-SILENT_TURN_TAIL)
    .trim();

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

  let deliveredUpTo: number | undefined;
  let firstPendingAt: number | undefined;
  let inFlight = false;
  let fails = 0;
  let stopped = false;
  /** Epoch ms before which this watcher does nothing (structural back-off). */
  let pausedUntil = 0;
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

  const pauseFor = (ms: number): void => {
    pausedUntil = Date.now() + ms;
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
      selection.harness !== undefined && selection.harness !== harnessName
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

  const attendTarget = async (
    state: FoldedState,
  ): Promise<
    { readonly harness: string; readonly sessionId: string; readonly cwd?: string } | undefined
  > => {
    const target = await artifactAttendant(paths, state.sessionHistory);
    if (!target?.sessionId) {
      // No id anywhere means nothing to resume - but a recorded resume command
      // still carries one, which is how an artifact whose agent never exported
      // `LUCID_SESSION_ID` stays attendable.
      const fromResume = target?.resume
        ? harnessSessionId({ resume: target.resume, artifactDir: paths.artifactDir })
        : undefined;
      if (!target?.harness || !fromResume) return undefined;
      return {
        harness: target.harness,
        sessionId: fromResume,
        ...(await resumeCwd(fromResume, target.cwd)),
      };
    }
    return {
      harness: target.harness,
      sessionId: target.sessionId,
      ...(await resumeCwd(target.sessionId, target.cwd)),
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
  const reportSilentTurn = async (through: number): Promise<void> => {
    // Anything the turn itself recorded is a better answer than its stdout.
    // OUTPUT events only: the delivery ack is ours, written before the turn
    // even started, and counting it made every turn look like it had spoken.
    const events = (await readEvents(paths.logPath)).events;
    const spoke = events.some(
      (e) => e.seq > through && (e.t === "version" || e.t === "agent_reply" || e.t === "question"),
    );
    if (spoke) return;
    const output = await readFile(paths.attendLog, "utf8").catch(() => "");
    // Lucid's OWN narration is not the agent's words. LUCID_VERBOSE propagates
    // into the spawned turn (it inherits the environment), and that turn's
    // stderr is this very file - so without this filter the last 600
    // characters of a quiet turn can be `[anchors] …` lines, delivered into
    // the artifact's log as an agent_reply and shown to the human in the
    // viewer as something the agent said. Permanently, in log.ndjson.
    const tail = relayableTail(output);
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
    if (!record?.sessionId) {
      unattendable("no harness session recorded on this artifact");
      return;
    }
    const registry = await loadRegistry(options.harnessesPath);
    const resolved = registry ? resolveRecipe(registry, record.harness) : undefined;
    if (!resolved) {
      unattendable(`no spawn recipe for harness "${record.harness}"`);
      return;
    }
    // Exact match only, unlike a fork: resuming session id X means re-entering
    // ONE harness's conversation, so the registry default is not a stand-in
    // for the harness that actually recorded it.
    // Normalized: `claude_code` in the registry IS `claude-code` on the
    // artifact. Still exact in every other sense - resuming session id X means
    // re-entering ONE harness's conversation, never the registry default.
    if (normalizeHarness(resolved.name) !== normalizeHarness(record.harness)) {
      unattendable(`harness "${record.harness}" is not in the registry`);
      return;
    }
    if (!resolved.recipe.resume) {
      unattendable(`recipe "${resolved.name}" has no resume argv`);
      return;
    }

    const target = state.highSeq;
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
    const prompt = revisePrompt(payload, paths.artifactPath);
    if (prompt === null) {
      // Pending, but nothing an agent can act on (a skipped question). Consume
      // it rather than re-deciding on it every poll.
      deliveredUpTo = target;
      firstPendingAt = undefined;
      return;
    }

    // Resume is cwd-scoped (D10): the session's own directory, else the
    // artifact's. The child is that harness session, never the hub's.
    const cwd = await usableCwd(record.cwd, paths.artifactDir);
    // The artifact's sticky model/effort: read before EVERY resume, so a
    // change takes effect on the next turn without remounting the session.
    // Re-validated every time too - the registry is a file a human edits, and
    // a pick it no longer offers must not reach the CLI as a dead flag.
    const applied = await applicableSelection(resolved.name, resolved.recipe);
    const argv = insertSelectionArgs(
      resolved.name,
      buildArgv(resolved.recipe.resume, {
        id: record.sessionId,
        artifact: paths.artifactPath,
        cwd,
        prompt,
      }),
      applied.args,
      resolved.recipe.resume,
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
    await deliver(paths, {
      t: "agent_ack",
      id: crypto.randomUUID(),
      intent: "revise",
      covers: target,
      // The artifact's own session (D18): the hub acts on its behalf, and the
      // events the turn writes must not be attributed to the hub.
      attendant: {
        harness: record.harness,
        sessionId: record.sessionId,
        cwd,
      },
    }).catch(() => {
      /* presence is advisory; a failed ack must not cancel the delivery */
    });
    log(`attend ${paths.name}: delivering feedback via "${resolved.name}" resume`);
    const code = await runSpawn(argv, cwd, paths.attendLog, {
      harness: record.harness,
      sessionId: record.sessionId,
      // Only what the argv actually carries: a dropped stale pick must not
      // stamp the child as running a model it was never given.
      ...(applied.model !== undefined ? { model: applied.model } : {}),
      ...(applied.effort !== undefined ? { effort: applied.effort } : {}),
    });
    if (code === 0) {
      // Advance only on a clean turn, so a failed one retries the batch
      // instead of silently swallowing the human's feedback.
      deliveredUpTo = target;
      firstPendingAt = undefined;
      fails = 0;
      await reportSilentTurn(target);
      return;
    }
    fails += 1;
    // A usage-limited harness is a WALL, not a flake: retrying burns nothing
    // but time, and the human sees feedback stuck at "recorded" with no clue
    // why. Name it in the viewer and stand down for the cool-off at once.
    const output = await readFile(paths.attendLog, "utf8").catch(() => "");
    const limit = detectUsageLimit(output);
    if (limit !== null) {
      fails = 0;
      pauseFor(ATTEND_COOLOFF_MS);
      const message = `Delivery is paused: the attending harness is over its usage limit. ${limit}`;
      log(`attend ${paths.name}: ${message}`);
      options.warn?.("HARNESS_USAGE_LIMIT", message);
      return;
    }
    if (fails >= MAX_ATTEND_FAILS) {
      fails = 0;
      pauseFor(ATTEND_COOLOFF_MS);
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
    if (now < pausedUntil) return;
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
    "Then open it for review by running:",
    `  lucid open ${shellArg(artifact)}`,
    `Write only ${artifact}; do not modify other files.`,
  ].join("\n");
