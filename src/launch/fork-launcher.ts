import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureServer, type EnsureServerOptions, openBrowser } from "../cli/self.ts";
import {
  mergeAttendantSidecar,
  readLastAttendant,
  recordSessionInvalidation,
  type Attendant,
} from "../core/attendant.ts";
import { parseCursor, renderCursor } from "../core/cursor.ts";
import { promotePendingBindings } from "../core/deliver.ts";
import type { ForkRecord } from "../core/fold.ts";
import { sessionState } from "../core/log.ts";
import { sessionPaths, type SessionPaths } from "../core/paths.ts";
import type { WaitPayload } from "../core/payload.ts";
import { harnessHasLocalStore, harnessTranscriptPath } from "../core/presence.ts";
import { registerSession } from "../core/registry.ts";
import { openSession } from "../core/session.ts";
import { runWait } from "../core/wait.ts";
import { discoverLiveServer } from "../server/discovery.ts";
import { stdoutSink } from "../server/observe.ts";
import { resolveView, wantsBrowserWindow } from "../server/view.ts";
import { createPrompt, revisePrompt } from "./prompts.ts";
import {
  buildArgv,
  resolveRecipe,
  registryPath,
  type HarnessRegistry,
  type RecipeVar,
  type SpawnRecipe,
} from "./recipes.ts";
import { safeForkId, writeForkSeed } from "./seed.ts";
import { prepareSpawnIdentity, runSpawn } from "./spawn.ts";
import { DEFAULT_TURN_IDLE_MS, planTurn, runTurn } from "./turn.ts";

/**
 * The fork launcher (Phase 2). An opt-in, foreground process the human runs
 * alongside a review. Spawning agents at all is a deliberate, human-initiated
 * exception to D-064 (the review server still only appends to a log); the
 * launcher is one of the two opt-ins that hold it, the other being a hub
 * started with `--attend` (D15). It stays agent-agnostic by running the
 * harness's declared recipe, never a hardcoded launch command.
 *
 * Shape C: the launcher itself holds the listening presence on a forked child
 * (via `runWait`, which registers as an agent listener) and spawns a
 * short-lived agent only when feedback arrives - no idle agent process per
 * artifact. It yields a child the moment a human attaches their own harness
 * (single-attendant invariant).
 */

/** Sidecar harness name the launcher records for its own attendance, so a human
 *  attendant is distinguishable and the launcher knows to yield. */
export const LAUNCHER_HARNESS = "lucid-launcher";

export interface LaunchOptions {
  /** Poll interval for new forks on the parent (ms). */
  readonly pollMs?: number;
  /** Open a browser tab for a child the launcher had to open as a fallback. */
  readonly openBrowser?: boolean;
  /** Stop the loop cooperatively. */
  readonly signal?: AbortSignal;
  /** How long a resume turn may write nothing before it is killed as wedged
   *  (tests inject a short one; the default is minutes). */
  readonly stallIdleMs?: number;
  /** Activity sink (human-readable lines). Defaults to stdout. */
  readonly log?: (message: string) => void;
  /** Override how a child viewer is ensured live (seam for tests, which cannot
   *  spawn a detached CLI). Defaults to the detached per-session daemon. */
  readonly openChild?: (child: SessionPaths, browser: boolean) => Promise<boolean>;
}

export type ChildStatus = "created" | "no-recipe" | "author-failed";

export interface CreatedChild {
  readonly forkId: string;
  readonly childArtifact: string;
  readonly childSessionId: string;
  readonly harness: string | null;
  readonly status: ChildStatus;
}

const DEFAULT_POLL_MS = 1500;
/** Consecutive failed resume turns before the launcher gives up on a batch
 *  (advances past it) rather than retrying forever on a broken recipe. */
const MAX_RESUME_FAILS = 3;

const handledPath = (parent: SessionPaths): string =>
  join(parent.sessionDir, "forks", "handled.json");

/**
 * The set of forks already acted on. A missing file means "nothing handled"
 * (first run); a PRESENT-but-corrupt file throws rather than silently resetting
 * to empty - because an empty set re-spawns every prior fork, the exact
 * duplicate-agent outcome the mark-before-spawn design exists to avoid.
 */
const loadHandled = async (parent: SessionPaths): Promise<Set<string>> => {
  let raw: string;
  try {
    raw = await readFile(handledPath(parent), "utf8");
  } catch {
    return new Set(); // absent = first run
  }
  const arr = JSON.parse(raw) as unknown; // a parse error is loud, never swallowed
  if (!Array.isArray(arr)) throw new Error(`corrupt handled.json at ${handledPath(parent)}`);
  return new Set(arr.filter((x): x is string => typeof x === "string"));
};

/** Persist the handled set atomically (temp + rename) so a crash mid-write can
 *  never leave a truncated file that reads back as "nothing handled". */
const saveHandled = async (parent: SessionPaths, handled: Set<string>): Promise<void> => {
  await mkdir(join(parent.sessionDir, "forks"), { recursive: true });
  const target = handledPath(parent);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify([...handled], null, 2)}\n`);
  await rename(tmp, target);
};

/** Deterministic child artifact path: same dir as the parent, keyed by the FULL
 *  sanitized fork id so a re-run never mints a second file for the same fork and
 *  distinct forks never collide onto one path. */
export const childArtifactPath = (parent: SessionPaths, forkId: string): string =>
  join(parent.artifactDir, `${parent.name}-fork-${safeForkId(forkId)}.html`);

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Ensure a child artifact has a live viewer (the recipe's agent should have run
 * `lucid open`; this is the fallback when it did not). No stdout print - the
 * launcher owns its own output stream.
 *
 * Starting the server is `ensureServer`'s job, not this function's: it holds
 * the descriptor lock, and a second read-then-spawn down here would be the
 * duplicate-appender race that lock exists to prevent. The windows are real -
 * a detached server still booting after the child's own `lucid open` was
 * killed with its turn, or another process opening the same deterministic
 * child path. What stays here is what is genuinely the launcher's: an
 * unauthored artifact means the agent never wrote one, and the launch decision.
 */
export const ensureChildOpen = async (
  childPaths: SessionPaths,
  browser: boolean,
  options: EnsureServerOptions = {},
): Promise<boolean> => {
  if (!(await discoverLiveServer(childPaths))) {
    if (!(await fileExists(childPaths.artifactPath))) return false;
    await openSession(childPaths);
    const identity = await ensureServer(childPaths, options);
    if (!identity) return false;
    // The view governs every launch, not only `open`'s (plan 06): a fork spawned
    // from inside a chat app's pane must not pop a window over the human's
    // conversation. The URL is already the solo one here - a fork's child gets
    // its own dedicated server - so only the launch is in question.
    //
    // Unconditional inside this branch, deliberately: two launchers racing on
    // one child adopt the single server the lock allowed and each pop a window.
    // Launching only from the caller that actually spawned would dedupe that,
    // and would lose the window in the normal case this fallback exists for -
    // the child's own `lucid open` started a server and was killed with its
    // turn before it ever reached its own launch, so nobody would open one.
    // A second window onto one artifact is the cheaper failure.
    if (wantsBrowserWindow(browser, resolveView(process.env))) {
      openBrowser(`http://127.0.0.1:${identity.port}/__lucid/viewer`);
    }
  }
  // The same pointer `open` writes, so a fork child is discoverable like any
  // other session. Advisory there and advisory here: a registry failure must
  // never fail the child's open.
  await registerSession(childPaths.artifactPath).catch(() => {});
  return true;
};

const substitutions = (v: {
  id: string;
  seed: string;
  artifact: string;
  cwd: string;
  prompt: string;
}): Partial<Record<RecipeVar, string>> => v;

const createChild = async (
  parent: SessionPaths,
  fork: ForkRecord,
  registry: HarnessRegistry,
  opts: LaunchOptions,
): Promise<CreatedChild> => {
  const log = opts.log ?? stdoutSink;
  const childArtifact = childArtifactPath(parent, fork.id);
  const childPaths = sessionPaths(childArtifact);
  const childSessionId = crypto.randomUUID();
  const { seedPath, forkDir } = await writeForkSeed(parent, fork);
  const harness = (await readLastAttendant(parent))?.harness ?? null;
  const resolved = resolveRecipe(registry, harness ?? undefined);

  if (!resolved) {
    // No recipe for this harness: degrade to the copy-command (D-064), so the
    // human can drive the fork by hand rather than the launcher guessing.
    const cmd = `# no spawn recipe for harness ${harness ?? "(unknown)"} - drive this fork manually:\n# 1) author ${childArtifact} from the seed: ${seedPath}\n# 2) lucid open ${childArtifact}\n`;
    await writeFile(join(forkDir, "COMMAND.txt"), cmd);
    log(
      `fork ${fork.id.slice(0, 8)}: no recipe for "${harness ?? "unknown"}" -> wrote manual command`,
    );
    return { forkId: fork.id, childArtifact, childSessionId, harness, status: "no-recipe" };
  }

  const spawnIdentity = prepareSpawnIdentity(resolved.name, resolved.recipe, registryPath());
  const argv = buildArgv(
    resolved.recipe.spawn,
    substitutions({
      // Caller-assigned recipes take the id Lucid minted; discovered recipes
      // declared no {id} in spawn (the registry validated that), so the empty
      // substitution never lands in an argv.
      id: spawnIdentity.assignedSessionId ?? "",
      seed: seedPath,
      artifact: childArtifact,
      cwd: parent.artifactDir,
      prompt: createPrompt(seedPath, childArtifact),
    }),
    resolved.recipe.tools,
  );
  const short = safeForkId(fork.id).slice(0, 8);
  log(`fork ${short}: spawning "${resolved.name}" -> ${childArtifact}`);
  await spawnIdentity.recordAssigned(childPaths);
  const result = await runSpawn(
    argv,
    parent.artifactDir,
    join(forkDir, "run", "create.out.log"),
    spawnIdentity.identityFor(childPaths),
  );
  if (result.code !== 0) {
    log(`fork ${short}: create turn exited ${result.code} (see ${forkDir}/run/create.out.log)`);
  } else if (result.status === "identity-missing") {
    // The artifact (if authored) survives; the launch is simply not resumable
    // (HSI002) - said HERE, where the launch record is, not discovered later
    // as a resume that starts a stranger.
    log(`fork ${short}: turn completed but announced no session identity (HSI002)`);
  }

  const open = opts.openChild ?? ensureChildOpen;
  if (!(await open(childPaths, opts.openBrowser ?? true))) {
    log(`fork ${short}: agent did not author ${childArtifact}`);
    return { forkId: fork.id, childArtifact, childSessionId, harness, status: "author-failed" };
  }
  log(`fork ${short}: opened ${childPaths.name}`);
  // The child's `lucid open` ran mid-turn, possibly before discovery fired:
  // promote anything still pending now that the log exists.
  await promotePendingBindings(childPaths).catch(() => {});
  // The id the attend loop resumes: assigned, or whatever the harness
  // announced. Neither means one-shot - the loop refuses to resume nothing.
  const resumableId =
    spawnIdentity.assignedSessionId ??
    ("identity" in result ? result.identity?.sessionId : undefined);
  if (resumableId) {
    // Shape-C liveness runs for the loop's lifetime; a failure here never
    // aborts the parent watch, but it must be observable rather than
    // silently swallowed.
    void attendChild(childPaths, resumableId, resolved.recipe, opts, resolved.name).catch((err) =>
      log(`${childPaths.name}: attend loop errored: ${(err as Error).message}`),
    );
  } else {
    log(`${childPaths.name}: no native identity to resume - artifact is one-shot`);
  }
  return {
    forkId: fork.id,
    childArtifact,
    childSessionId: resumableId ?? "",
    harness,
    status: "created",
  };
};

/**
 * One pass over the parent's forks: create a child for each not-yet-handled
 * fork. A fork is marked handled BEFORE spawning (idempotency over retry): a
 * duplicate child - two agent runs, two artifacts - is worse than a dropped
 * fork the human can re-request.
 */
export const handleForks = async (
  parent: SessionPaths,
  registry: HarnessRegistry,
  opts: LaunchOptions = {},
): Promise<CreatedChild[]> => {
  const log = opts.log ?? stdoutSink;
  const state = await sessionState(parent);
  const handled = await loadHandled(parent);
  const fresh = state.forks.filter((f) => !handled.has(f.id));
  if (fresh.length === 0) return [];
  // Mark handled before spawning (idempotency over retry), persisted once for
  // the whole batch. Then create concurrently: a slow create must not serialize
  // the batch, and one fork's failure must never abort the others or the watch.
  for (const f of fresh) handled.add(f.id);
  await saveHandled(parent, handled);
  return Promise.all(
    fresh.map((fork) =>
      createChild(parent, fork, registry, opts).catch((err) => {
        log(`fork ${safeForkId(fork.id).slice(0, 8)}: create failed: ${(err as Error).message}`);
        return {
          forkId: fork.id,
          childArtifact: childArtifactPath(parent, fork.id),
          childSessionId: "",
          harness: null,
          status: "author-failed" as const,
        };
      }),
    ),
  );
};

/**
 * Has somebody OTHER than this launcher taken delivery of the child?
 *
 * `nextCursor` is what makes a sidecar an ATTENDANCE record: it says a reader
 * consumed the log up to a point. A sidecar without one is an identity record
 * - the launcher's own `recordAssigned`/discovery write, naming the harness it
 * is about to spawn - and reading that as "a human attached" made the loop
 * yield to itself on its first pass, leaving every forked artifact one-shot.
 */
export const attendedByAnother = (attendant: Attendant): boolean =>
  attendant.nextCursor !== undefined && attendant.harness !== LAUNCHER_HARNESS;

/** Shape-C attend loop for one child: hold the listening presence, re-drive the
 *  same session on each feedback batch, yield to a human who attaches. */
export const attendChild = async (
  child: SessionPaths,
  initialSessionId: string,
  recipe: SpawnRecipe,
  opts: LaunchOptions,
  harnessName = "agent",
): Promise<void> => {
  const log = opts.log ?? stdoutSink;
  if (!recipe.resume) {
    log(`${child.name}: recipe has no resume argv - forked artifact is one-shot`);
    return;
  }
  // Reassignable: an ALLOWED rotation moves the loop to the thread the
  // harness announced, so later turns resume what actually exists.
  let sessionId = initialSessionId;
  // Start from now: a fresh child has no prior feedback to re-apply.
  let cursor = renderCursor((await sessionState(child)).highSeq);
  let fails = 0;
  for (;;) {
    if (opts.signal?.aborted) return;
    // Single-attendant: yield the moment a non-launcher harness attends.
    const attendant = await readLastAttendant(child);
    if (attendant && attendedByAnother(attendant)) {
      log(`${child.name}: yielding to "${attendant.harness}" (human attached)`);
      return;
    }
    let payload: WaitPayload;
    try {
      payload = await runWait(child, { since: cursor, timeoutMs: 30_000 });
    } catch {
      return; // session gone
    }
    if (payload.status === "ended" || payload.status === "suspended") {
      log(`${child.name}: ${payload.status}, stopping attend`);
      return;
    }
    if (payload.status !== "feedback") {
      cursor = payload.nextCursor; // version-only / waiting: advance and re-block
      continue;
    }
    if (payload.reviewResolved) {
      log(`${child.name}: review approved, stopping attend`);
      return;
    }
    // Re-check ownership right before driving: a human who attached while we were
    // blocked in wait must preempt THIS batch, not only the next. An advisory
    // sidecar can't lock, but re-checking here closes the common race window; do
    // NOT advance the cursor, so the human owns the unconsumed batch.
    const owner = await readLastAttendant(child);
    if (owner && attendedByAnother(owner)) {
      log(`${child.name}: yielding to "${owner.harness}" before driving batch`);
      return;
    }
    const prompt = revisePrompt(payload, child.artifactPath);
    if (prompt === null) {
      cursor = payload.nextCursor; // feedback with nothing to apply: skip the turn
      continue;
    }
    await mergeAttendantSidecar(child, {
      harness: LAUNCHER_HARNESS,
      nextCursor: payload.nextCursor,
      at: new Date().toISOString(),
    });
    // What this turn takes delivery of (D20) - the batch just read, not
    // whatever has landed by the time the ack appends.
    const covers = parseCursor(payload.nextCursor);
    // Every resume turn is its OWN launch: fresh correlation, the recipe's
    // declared strategy, guarded discovery persistence, and the artifact's own
    // sticky model/effort. Planned and run by the turn owner, because a child
    // driven here and an artifact attended by the hub must not disagree about
    // what a harness said (plan 03, D-012) - and a fork child that ignored the
    // selection its human had picked was exactly that disagreement.
    const planned = await planTurn({
      mode: "resume",
      paths: child,
      harness: harnessName,
      recipe,
      registryFile: registryPath(),
      sessionId,
      cwd: child.artifactDir,
      prompt,
    });
    if (planned.status === "refused") {
      log(`${child.name}: ${planned.reason} - stopping attend`);
      return;
    }
    // A stale pick DEGRADES rather than stalling delivery, so it is something
    // to SAY: the turn runs on the harness's own defaults, and a child driven
    // at the wrong model with nothing in the launcher log is worse than one
    // that never carried a pick at all. This log is the launcher's only voice
    // - there is no panel warning down here.
    if (planned.selectionIssue !== undefined) log(`${child.name}: ${planned.selectionIssue}`);
    // One store walk, two answers, the same pair the hub's engine reads. The
    // transcript is the one signal a buffered-stdout CLI still moves during a
    // long turn: the out-log of a `claude -p` resume sits at zero bytes through
    // minutes of real work, and a watchdog measuring only that kills a healthy
    // turn. Its ABSENCE, where Lucid knows the harness's store, is a pre-flight
    // refusal - the conversation cannot be resumed from this machine, so the
    // spawn would die as an unexplained "Execution error" AND run unwatched on
    // the way. A harness Lucid has no store adapter for corroborates nothing
    // and is driven as before.
    const knowsStore = harnessHasLocalStore(harnessName);
    const transcript = knowsStore ? await harnessTranscriptPath(harnessName, sessionId) : undefined;
    if (knowsStore && transcript === undefined) {
      // Stand down without advancing the cursor, so the feedback stays the
      // human's: there is no second candidate to try down here, which is the
      // stance this loop already takes on a not-found verdict.
      log(`${child.name}: no local "${harnessName}" transcript for ${sessionId} - stopping attend`);
      return;
    }
    const outcome = await runTurn(planned, {
      // Where THIS run's output starts is the owner's problem now: the log is
      // opened in append mode, so classifying the whole file would let an
      // earlier turn's not-found banner durably quarantine a live session.
      outLog: child.reviseLog,
      ...(covers !== undefined ? { covers } : {}),
      // A wedged child holds this artifact for as long as the launcher lives,
      // and nothing down here would ever notice. Bounded on SILENCE, never on
      // duration.
      deadline: {
        idleMs: opts.stallIdleMs ?? DEFAULT_TURN_IDLE_MS,
        activityPaths: transcript !== undefined ? [transcript] : [],
      },
      onDelivered: () => log(`${child.name}: applying feedback via resume`),
    });
    const code = outcome.code;
    if (outcome.identity?.status === "mismatch") {
      // HSI005: a different conversation answered. Do not bind, do not
      // invalidate, do not advance - the feedback stays the human's.
      log(`${child.name}: resume announced a different session (HSI005); stopping this batch`);
      return;
    }
    if (outcome.sessionNotFound) {
      // A verdict, not a flake: quarantine the id durably and stop driving
      // this child - there is no second candidate to try down here.
      await recordSessionInvalidation(child, harnessName, sessionId).catch(() => {});
      log(`${child.name}: harness says session ${sessionId} does not exist here (HSI004)`);
      return;
    }
    if (outcome.identity?.status === "rotated") {
      // An allowed rotation: the loop follows the harness to its new thread.
      sessionId = outcome.identity.identity.sessionId;
    }
    // Consume the batch (advance the cursor) only on a clean turn, so a failed
    // resume is retried rather than silently dropping the feedback. Bounded, so a
    // persistently broken recipe can't spin forever.
    if (code === 0) {
      cursor = payload.nextCursor;
      fails = 0;
      continue;
    }
    fails += 1;
    if (fails >= MAX_RESUME_FAILS) {
      log(`${child.name}: resume failed ${fails}x (exit ${code}); giving up on this batch`);
      cursor = payload.nextCursor;
      fails = 0;
    } else {
      log(`${child.name}: resume exited ${code} (attempt ${fails}); will retry the batch`);
    }
  }
};

/** The foreground launcher loop: poll the parent for forks until the parent
 *  session ends or the signal aborts. */
export const runLaunch = async (
  parent: SessionPaths,
  registry: HarnessRegistry,
  opts: LaunchOptions = {},
): Promise<void> => {
  const log = opts.log ?? stdoutSink;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  log(`launcher watching ${parent.name} for forks (Ctrl-C to stop)`);
  for (;;) {
    if (opts.signal?.aborted) return;
    const state = await sessionState(parent);
    if (state.status === "ended") {
      log(`${parent.name}: session ended, launcher stopping`);
      return;
    }
    await handleForks(parent, registry, opts);
    await new Promise((r) => setTimeout(r, pollMs));
  }
};
