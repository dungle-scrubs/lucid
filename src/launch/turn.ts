import { readFile, stat } from "node:fs/promises";
import { deliver } from "../core/deliver.ts";
import { normalizeHarness } from "../core/harness.ts";
import type { SessionPaths } from "../core/paths.ts";
import {
  detectAuthFailure,
  detectUsageLimit,
  type AuthFailureKind,
  type UsageLimitKind,
} from "./limits.ts";
import {
  buildArgv,
  requireSessionIdentity,
  spawnedSessionId,
  type SpawnRecipe,
} from "./recipes.ts";
import { insertSelectionArgs, readSelection, selectionArgs } from "./selection.ts";
import {
  classifyObservedIdentity,
  classifySessionFailure,
  mintLaunchId,
  mintTurnId,
  type ObservedIdentityOutcome,
  type SessionIdentityRecipe,
  type SpawnResult,
} from "./session-identity.ts";
import { discoveryPersistence, runSpawn, type SpawnDeadline } from "./spawn.ts";

/**
 * Driving ONE headless turn.
 *
 * Three surfaces used to re-derive the same sequence - the fork launcher's
 * Shape-C resume, the hub's attend engine, the hub's create - and each one
 * decided for itself what a dead turn's output meant, whether the stall
 * watchdog applied, and whether the artifact's sticky selection reached the
 * argv. This module owns the parts that must not differ by call site; the
 * drivers keep the parts that are genuinely theirs (which batch to take, when
 * to stand down, what to tell the human).
 *
 * Layering, because the paragraph above implies more isolation than the
 * imports hold: the ack and the terminator go through `core/deliver`, which
 * POSTs to a live server and so reaches `server/discovery` (and
 * `server/observe` behind it). Those two are leaves - nothing under them
 * imports back - which is what leaves `server/attend` and `server/daemon` free
 * to consume this module. A new `src/server` import added here has to keep
 * that property, or the loop closes.
 */

/**
 * Why a dead turn died: the two walls a harness can hit, and the turn-record
 * shape they map to.
 *
 * Both detectors run on every dead turn, because a consumer can want either
 * separately - the create dialog reports the usage wall and the auth wall as
 * distinct facts, since their remedies have nothing in common. `reason` and
 * `code` are the single ranking the RECORD carries when both could apply: a
 * usage wall outranks an auth wall, because a harness over its budget will
 * not authenticate its way back in.
 *
 * Identifiers throughout, never the harness's sentence (D-005): the line that
 * matched can carry a prompt, a filename or a customer's name, and both
 * consumers of a classification are retained.
 */
export interface TurnFailure {
  readonly usageLimit: UsageLimitKind | null;
  readonly authFailure: AuthFailureKind | null;
  /** The `agent_turn_ended` reason this diagnosis maps to. */
  readonly reason: "failed" | "usage_limit";
  /** The `agent_turn_ended` code (TURN_END_CODE charset), absent when the
   *  output named no wall at all. */
  readonly code?: string;
}

/** Turn a wall's kind into the log's identifier charset: the kinds are
 *  hyphenated on the warning wire, and `code` takes underscores. */
const asCode = (kind: string): string => kind.replaceAll("-", "_");

/**
 * What THIS run's output says about why the turn died. Callers pass the slice
 * belonging to their own run - the out-logs are append-mode and shared across
 * attempts, so classifying the whole file lets an earlier turn's wall be
 * reported as this one's.
 */
export const classifyTurnFailure = (output: string): TurnFailure => {
  const usageLimit = detectUsageLimit(output);
  const authFailure = detectAuthFailure(output);
  if (usageLimit !== null) {
    return { usageLimit, authFailure, reason: "usage_limit", code: asCode(usageLimit) };
  }
  if (authFailure !== null) {
    // Still `failed` - the closed reason set has no auth member, and the code
    // is what tells the two failures apart in the record. Namespaced, so an
    // auth kind and a limit kind can never collide on one identifier.
    return { usageLimit, authFailure, reason: "failed", code: `auth_${asCode(authFailure)}` };
  }
  return { usageLimit, authFailure, reason: "failed" };
};

/**
 * How long a driven turn may write NOTHING before it is treated as wedged.
 *
 * The fork launcher passed no deadline at all, so the watchdog protected only
 * the hub - a wedged Shape-C resume held its child artifact for as long as the
 * launcher lived, which is exactly the 53-minute wedge the watchdog exists to
 * end. One default, so a turn's patience cannot depend on which driver started
 * it.
 */
export const DEFAULT_TURN_IDLE_MS = 8 * 60 * 1000;

/**
 * Where a run's output will start in an out-log every attempt appends to.
 *
 * Captured BEFORE the process exists, because the alternative - reading the
 * whole file afterwards - reports an earlier attempt's evidence as this one's:
 * a not-found banner that durably quarantines a live session, a usage wall
 * inherited by an unrelated later crash, a second create attempt whose dialog
 * tails the first one's error with no separator. A log that does not exist yet
 * starts at zero.
 */
export const runOutputStart = (outLog: string): Promise<number> =>
  stat(outLog).then(
    (s) => s.size,
    () => 0,
  );

/** THIS run's bytes from that out-log. An unreadable log is empty output: the
 *  turn's exit code is the story, and a missing file must not throw inside the
 *  classification of a turn that has already ended. */
export const readRunOutput = async (outLog: string, from: number): Promise<string> =>
  (await readFile(outLog, "utf8").catch(() => "")).slice(from);

/** Which template a turn runs. A RESUME re-enters a recorded conversation; a
 *  HANDOFF gives the artifact to a session that does not exist yet - the same
 *  sequence, minus an id to hold the harness to. */
export type TurnMode = "handoff" | "resume" | "create";

/** What a driver knows before a turn can be planned. */
export interface TurnRequest {
  readonly mode: TurnMode;
  /** The artifact this turn drives: its record, its sticky selection, and the
   *  path the argv substitutes for `{artifact}`. */
  readonly paths: SessionPaths;
  readonly harness: string;
  readonly recipe: SpawnRecipe;
  /** The registry file an identity refusal (HSI001) names. */
  readonly registryFile: string;
  /** The recorded session a resume re-enters. A handoff has none. */
  readonly sessionId?: string;
  /** Where the harness can FIND that session (D10), and the turn's own cwd. */
  readonly cwd: string;
  readonly prompt: string;
}

/** A turn that must not start, and why. Typed rather than thrown: every
 *  driver has its own way of standing down, and none of them is an exception
 *  escaping into a poll timer. */
export interface TurnRefusal {
  readonly status: "refused";
  /** HSI001 = the recipe declares no identity strategy · `no-argv` = it has no
   *  template for this mode · `no-session` = a resume with nothing to resume. */
  readonly code: "HSI001" | "no-argv" | "no-session";
  readonly reason: string;
}

/** Everything decided before the process exists. */
export interface PlannedTurn {
  readonly status: "planned";
  readonly mode: TurnMode;
  readonly paths: SessionPaths;
  readonly harness: string;
  readonly cwd: string;
  /** The TURN this launch IS (plan 08, D-013): minted before the ack that
   *  opens its window, so the terminator closes the same turn. */
  readonly turnId: string;
  /** Lucid-owned correlation for this launch (plan 03). Never resume argv. */
  readonly launchId: string;
  readonly argv: readonly string[];
  /** The id this launch names: the session a resume re-enters, the one minted
   *  for a caller-assigned handoff, or nothing - a discovered harness mints
   *  its own and announces it. */
  readonly sessionId?: string;
  /** Absent only for a legacy resume: no discovery, no authority export. */
  readonly strategy?: SessionIdentityRecipe;
  readonly allowRotation: boolean;
  /** Why the artifact's sticky pick was NOT applied. A stale pick degrades
   *  (the turn runs on the CLI's own defaults) rather than stalling delivery,
   *  so this is something to SAY, never a refusal. */
  readonly selectionIssue?: string;
  /** Only what the argv actually carries: a dropped stale pick must not stamp
   *  the child as running a model it was never given. */
  readonly model?: string;
  readonly effort?: string;
}

/**
 * The artifact's sticky selection as argv, or nothing plus the reason it no
 * longer applies. Re-read and re-validated for EVERY turn: a change takes
 * effect on the next one without remounting, and the registry is a file a
 * human edits, so a pick it no longer offers must not reach the CLI as a dead
 * flag.
 */
const applicableSelection = async (
  paths: SessionPaths,
  harness: string,
  recipe: SpawnRecipe,
): Promise<{
  readonly args: readonly string[];
  readonly issue?: string;
  readonly model?: string;
  readonly effort?: string;
}> => {
  const selection = await readSelection(paths);
  if (!selection) return { args: [] };
  const composed =
    selection.harness !== undefined &&
    normalizeHarness(selection.harness) !== normalizeHarness(harness)
      ? {
          error: `the saved pick was made for harness "${selection.harness}", but this artifact resumes under "${harness}"`,
        }
      : selectionArgs(harness, recipe, selection);
  if ("error" in composed) {
    return {
      args: [],
      issue: `Model/effort selection ignored: ${composed.error}. This turn runs on the harness's own defaults.`,
    };
  }
  return {
    args: composed,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
  };
};

/**
 * Decide what this turn runs as: which template, under which identity, with
 * the artifact's sticky selection woven in.
 *
 * The identity policy is the reason this is one function rather than three.
 * A HANDOFF starts a session, so it is bound by the rule the create paths
 * already hold (HSI001): a recipe that declares no strategy would have Lucid
 * mint a UUID nothing can ever resume, which is the synthetic identity that
 * poisoned resume in the first place. A RESUME names an id the record already
 * holds, so a legacy recipe that declares nothing still re-enters its own
 * conversation - nothing synthetic is invented there.
 */
export const planTurn = async (request: TurnRequest): Promise<PlannedTurn | TurnRefusal> => {
  const { cwd, harness, mode, paths, prompt, recipe } = request;
  const template = mode === "resume" ? recipe.resume : recipe.spawn;
  if (!template) {
    return {
      status: "refused",
      code: "no-argv",
      reason: `recipe "${harness}" has no ${mode === "resume" ? "resume" : "spawn"} argv`,
    };
  }
  let strategy: SessionIdentityRecipe | undefined;
  if (mode !== "resume") {
    // handoff AND create: require identity, mint a UUID for caller-assigned.
    try {
      strategy = requireSessionIdentity(harness, recipe, request.registryFile);
    } catch (err) {
      return { status: "refused", code: "HSI001", reason: (err as Error).message };
    }
  } else {
    strategy = recipe.sessionIdentity;
    if (request.sessionId === undefined) {
      return {
        status: "refused",
        code: "no-session",
        reason: `a resume of "${harness}" needs the session id it re-enters`,
      };
    }
  }
  const sessionId =
    mode === "resume"
      ? request.sessionId
      : strategy?.source === "caller-assigned"
        ? crypto.randomUUID()
        : undefined;
  const applied = await applicableSelection(paths, harness, recipe);
  const argv = insertSelectionArgs(
    harness,
    buildArgv(
      template,
      {
        id: sessionId ?? "",
        artifact: paths.artifactPath,
        cwd,
        prompt,
      },
      recipe.tools,
    ),
    applied.args,
    template,
  );
  return {
    status: "planned",
    mode,
    paths,
    harness,
    cwd,
    turnId: mintTurnId(),
    launchId: mintLaunchId(),
    argv,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(strategy ? { strategy } : {}),
    allowRotation: strategy?.source === "stdout-jsonl" && strategy.allowRotation === true,
    ...(applied.issue !== undefined ? { selectionIssue: applied.issue } : {}),
    ...(applied.model !== undefined ? { model: applied.model } : {}),
    ...(applied.effort !== undefined ? { effort: applied.effort } : {}),
  };
};

/** What the driver contributes at run time: where the output goes, what the
 *  turn takes delivery of, and the two moments it wants back. */
export interface TurnDrive {
  /** The append-mode out-log this run's bytes join. */
  readonly outLog: string;
  /** The batch this turn takes delivery of (D20): the one just read, never
   *  whatever has landed by the time the ack appends. */
  readonly covers?: number;
  /** The hub request that caused this turn (M1.3). */
  readonly requestId?: string;
  /** The hub driving it, so the turn's own `lucid open` calls back HERE and
   *  not at whatever is listening on the default port. */
  readonly hubPort?: number;
  /** How long the turn may write nothing, and what else counts as it being
   *  alive. Omitted only where the caller genuinely wants no watchdog. */
  readonly deadline?: SpawnDeadline;
  /** Called once the delivery ack has landed: where a driver announces the
   *  batch it just claimed, in its own words. */
  readonly onDelivered?: () => void;
  /** Called the instant the child exits, before any classification - a claim
   *  held for the duration of the PROCESS is released here, not when this
   *  function returns. */
  readonly onSpawnSettled?: () => void;
}

/** How the turn ended, in the terms every driver has to make a decision on. */
export interface TurnOutcome {
  readonly result: SpawnResult;
  readonly code: number;
  /** THIS run's output only. The out-logs are append-mode and shared across
   *  attempts, so a whole-file read lets an earlier turn's banner be reported
   *  as this one's. */
  readonly output: string;
  /** Where this run's output starts, for a driver that reads the log again
   *  after the turn (a silent turn's relay). */
  readonly outputFrom: number;
  /** What a resume's announcement was judged to be - confirmed, an allowed
   *  rotation, or HSI005. Absent for a handoff, or when nothing was announced. */
  readonly identity?: ObservedIdentityOutcome;
  /** The harness says this native session does not exist here (HSI004). A
   *  VERDICT, not a flake: only an adapter match sets it. */
  readonly sessionNotFound: boolean;
  /** Why it died. Null on a clean turn. */
  readonly failure: TurnFailure | null;
  /** The parent had to KILL it: nothing was written anywhere for the whole
   *  idle window. A wedged harness process, never bad feedback. */
  readonly stalled: boolean;
  /** The session this turn established, as stamped on the terminator. */
  readonly establishedSessionId?: string;
}

/**
 * Run one planned turn: claim the batch, spawn it, and close the window it
 * opened - whatever it produced.
 *
 * The three things bracketed here are the three that must not differ by call
 * site. The ACK opens a working window and records the delivery before the
 * turn runs (D20). The TERMINATOR closes that window on the way out: without
 * it the batch sits marked delivered with nothing to show for it, and the
 * panel reports a dead turn as the live one forever. In between, the identity
 * rules - what the harness announced, judged against what was asked (HSI005),
 * and what its failure text means (HSI004) - are read once, from one place, so
 * an artifact driven by the launcher and one driven by the hub cannot disagree
 * about what a harness said.
 */
export const runTurn = async (planned: PlannedTurn, drive: TurnDrive): Promise<TurnOutcome> => {
  const { allowRotation, cwd, harness, launchId, paths, sessionId, strategy, turnId } = planned;
  const resuming = planned.mode === "resume";
  await deliver(paths, {
    t: "agent_ack",
    id: crypto.randomUUID(),
    turnId,
    // NO intent: an order to revise is not an outcome, and the turn is what
    // decides whether an edit actually follows. The prompt tells the turn to
    // declare that itself (`lucid intent`).
    ...(drive.covers !== undefined ? { covers: drive.covers } : {}),
    // The ARTIFACT's session (D18): the driver acts on its behalf, and the
    // events the turn writes must not be attributed to the driver. A handoff
    // is not a session until its spawn succeeds, so it stays unattributed -
    // stamping the target here made a pre-session failure look resumable.
    ...(resuming && sessionId !== undefined ? { attendant: { harness, sessionId, cwd } } : {}),
  }).catch(() => {
    /* presence is advisory; a failed ack must not cancel the delivery */
  });
  drive.onDelivered?.();
  const outputFrom = await runOutputStart(drive.outLog);
  let result: SpawnResult;
  try {
    result = await runSpawn(
      [...planned.argv],
      cwd,
      drive.outLog,
      {
        harness,
        ...(sessionId !== undefined ? { sessionId } : {}),
        turnId,
        launchId,
        ...(strategy ? { strategy } : {}),
        // Persistence while the turn is LIVE, through the one guarded
        // callback: a resume that announces a STRANGER is refused (HSI005),
        // never bound. A handoff has nothing to guard against - it asked for
        // no particular session.
        onIdentityDiscovered: discoveryPersistence(
          paths,
          harness,
          launchId,
          resuming && sessionId !== undefined
            ? { requestedSessionId: sessionId, allowRotation }
            : undefined,
        ),
        ...(drive.requestId !== undefined ? { requestId: drive.requestId } : {}),
        ...(drive.hubPort !== undefined ? { hubPort: drive.hubPort } : {}),
        ...(planned.model !== undefined ? { model: planned.model } : {}),
        ...(planned.effort !== undefined ? { effort: planned.effort } : {}),
      },
      drive.deadline,
    );
  } finally {
    drive.onSpawnSettled?.();
  }
  const code = result.code;
  const output = await readRunOutput(drive.outLog, outputFrom);
  const observed = "identity" in result ? result.identity : undefined;
  // The mismatch policy, from the classifier both drivers now share rather
  // than from an open-coded comparison that only happened to agree with it.
  const identity =
    resuming && sessionId !== undefined && observed !== undefined
      ? classifyObservedIdentity(sessionId, observed, allowRotation)
      : undefined;
  const failure = code === 0 ? null : classifyTurnFailure(output);
  // A not-found is a verdict the ADAPTER recognized; a usage wall is a
  // different failure entirely, and reading one as the other would quarantine
  // a live session because the plan ran out of budget.
  const sessionNotFound =
    code !== 0 &&
    resuming &&
    sessionId !== undefined &&
    failure?.usageLimit == null &&
    classifySessionFailure(harness, output) === "HSI004";
  // Identity established by this turn. Handoff: what the harness ANNOUNCED
  // wins; the legacy whole-output scan covers recipes that predate
  // declarations; a clean caller-assigned handoff established the id it was
  // given. Resume: the REQUESTED session stands - an announcement of the same
  // id confirms it, an allowed rotation adopts the new one, and a refused
  // mismatch keeps the requested id with the stranger left unbound (HSI005).
  const establishedSessionId = resuming
    ? identity?.status === "rotated"
      ? observed?.sessionId
      : sessionId
    : (observed?.sessionId ??
      spawnedSessionId(harness, output) ??
      (code === 0 ? sessionId : undefined));
  // Authority is a claim about HOW the id is known, so it never exceeds the
  // evidence: observed only for an announcement that was not refused, assigned
  // only for a caller-assigned handoff that ran clean - an id recovered by
  // scanning output text has no authority at all.
  const establishedAuthority =
    observed !== undefined && identity?.status !== "mismatch"
      ? "observed"
      : !resuming && code === 0 && strategy?.source === "caller-assigned"
        ? "assigned"
        : undefined;
  // An identity refusal outranks the exit code. A turn that answered from a
  // stranger's conversation, or named a session this machine does not hold,
  // did not deliver - however cleanly its process exited - and a terminator
  // reading `done` there would tell the panel all was well.
  const refused =
    identity?.status === "mismatch"
      ? "hsi005_session_mismatch"
      : sessionNotFound
        ? "hsi004_session_not_found"
        : undefined;
  // The turn stopped, whatever it produced. The driver held the child, so it
  // is the authoritative witness - and without this a turn that read the
  // feedback and produced nothing leaves its window open forever (finding #1).
  // Advisory: it moves no cursor and wakes no waiter.
  await deliver(paths, {
    t: "agent_turn_ended",
    turnId,
    reason: refused !== undefined ? "failed" : code === 0 ? "done" : (failure?.reason ?? "failed"),
    ...(refused !== undefined
      ? { code: refused }
      : failure?.code !== undefined
        ? { code: failure.code }
        : {}),
    ...(establishedSessionId !== undefined
      ? {
          attendant: {
            harness,
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
    // The turn is over regardless; a failed append is not worth retrying into
    // a loop. The stale state still covers the viewer.
  });
  return {
    result,
    code,
    output,
    outputFrom,
    ...(identity !== undefined ? { identity } : {}),
    sessionNotFound,
    failure,
    stalled: result.status === "process-failed" && result.stalled === true,
    ...(establishedSessionId !== undefined ? { establishedSessionId } : {}),
  };
};
