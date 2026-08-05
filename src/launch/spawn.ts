import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { recordPendingIdentity } from "../core/attendant.ts";
import { promotePendingBindings } from "../core/deliver.ts";
import type { SessionPaths } from "../core/paths.ts";
import { requireSessionIdentity, type SpawnRecipe } from "./recipes.ts";
import { buildSpawnEnv } from "./env-stamp.ts";
import {
  classifyObservedIdentity,
  classifySpawnResult,
  mintLaunchId,
  SessionIdentityDecoder,
  type NativeSessionIdentity,
  type SessionIdentityRecipe,
  type SpawnResult,
} from "./session-identity.ts";

/**
 * The one process-spawning seam. Every turn Lucid drives - the fork launcher's
 * create and its Shape-C resumes, the hub's create, and the hub's attend engine
 * - runs its harness recipe through `runSpawn`, so the three things that can
 * poison a session cannot differ by call site: what the child's env says its
 * identity is, what happens to an identity the harness announces, and what
 * counts as a turn that has stopped making progress.
 *
 * It stays agent-agnostic: the argv is the harness's declared recipe, never a
 * hardcoded launch command.
 */

/** What a spawner tells runSpawn about the launch's identity arrangement. */
export interface SpawnIdentity {
  readonly harness: string;
  /** The id Lucid assigns (caller-assigned recipes) or the parent-known id a
   *  legacy recipe still exports. Discovered recipes leave it unset - the
   *  harness mints its own and announces it on stdout. */
  readonly sessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  /** The hub request that caused this spawn (M1.3): stamped into the child
   *  env so the turn's own hub calls carry the click's id. Absent for a
   *  spawn no request caused (attend's poll) - and then CLEARED, so a
   *  stale inherited id cannot claim the wrong click. */
  readonly requestId?: string;
  /** The TURN this spawn IS (plan 08, D-013). Minted by the caller so it
   *  can name the same turn when it appends the terminator on exit, and
   *  exported so the child's own acks carry it - a turn nobody can name is
   *  a turn nobody can end. Cleared when absent, like requestId. */
  readonly turnId?: string;
  /** The hub doing the spawning (plan 08, finding #21). The create prompt
   *  ends by telling the turn to run `lucid open`, and `open` finds a hub
   *  through LUCID_HUB_PORT - so a hub anywhere but the default port spawned
   *  turns that opened their artifact into whatever else was listening
   *  there. Left ALONE when absent: not every spawner is a hub, and
   *  inventing a port would route a turn at one that does not exist. */
  readonly hubPort?: number;
  /** Lucid-owned correlation for THIS launch (plan 03): exported as
   *  LUCID_LAUNCH_ID so the child's stamps carry it, and required before any
   *  discovered identity can be persisted against the launch that found it.
   *  Never enters resume argv - correlation, not identity. */
  readonly launchId?: string;
  /** How this harness establishes native identity. Absent = legacy recipe:
   *  no discovery, no authority export, the pre-identity env behavior. */
  readonly strategy?: SessionIdentityRecipe;
  /** Called on the FIRST valid identity announcement while the child is
   *  still running, so discovery can be persisted before the turn ends. */
  readonly onIdentityDiscovered?: (identity: NativeSessionIdentity) => void | Promise<void>;
}

/**
 * How long a spawned turn may produce NOTHING before it is treated as wedged.
 *
 * A turn has no natural deadline - real work runs for minutes - so this bounds
 * silence, not duration. A child writing progress, prose or errors is alive
 * whatever its clock says; one that has written nothing at all for this long
 * is not coming back, and the artifact it holds cannot start another turn
 * until it stops.
 */
export interface SpawnDeadline {
  /** Milliseconds of NO output before the child is killed. */
  readonly idleMs: number;
  /**
   * Files beyond the out-log whose growth also counts as the child being
   * alive. Without these the watchdog killed every healthy `claude -p` turn
   * longer than the window: that CLI buffers stdout until the turn ENDS, so
   * its out-log sits at zero bytes through minutes of real work - while its
   * session transcript (and the artifact's own record, which the turn's
   * `lucid` calls append to) move on every step. A path that does not exist
   * yet simply counts as unchanged until it appears.
   */
  readonly activityPaths?: readonly string[];
}

/**
 * Kill a child that has gone silent for `idleMs`.
 *
 * Silence is measured off the OUT-LOG, not the parent's stdout tap: a
 * caller-assigned harness writes straight to the log fd, so the parent never
 * sees a chunk and has nothing else to measure. The file's size is the one
 * signal both arrangements share.
 *
 * This exists because a wedged child holds its artifact forever. `runSpawn`
 * awaited `proc.exited` with no bound, and the attend engine treats a live
 * child as a delivery in flight - so one hung process silently queued every
 * later piece of feedback behind it, with the panel still reporting an older
 * turn as though it were the live one. Measured on a real session: 53 minutes,
 * no output, six pieces of feedback undelivered.
 */
const watchForStall = (
  proc: { readonly kill: (signal?: number) => void },
  logFile: string,
  deadline: SpawnDeadline | undefined,
): { readonly fired: () => boolean; readonly stop: () => void } => {
  if (!deadline || deadline.idleMs <= 0) return { fired: () => false, stop: () => {} };
  // One stamp across every signal: the out-log's size plus each activity
  // file's size and mtime. Any change on any of them is life. A missing file
  // stamps as a constant, so a transcript that appears later registers as
  // change the moment it does.
  const stampOf = (path: string): string => {
    try {
      const s = statSync(path);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "-";
    }
  };
  const activity = deadline.activityPaths ?? [];
  const sizeOf = (): string => [logFile, ...activity].map(stampOf).join("|");
  let lastSize = sizeOf();
  let lastChangeAt = Date.now();
  let fired = false;
  // Checked several times per window rather than once at the end: the point is
  // to notice silence promptly, not to add a second timeout of its own.
  const every = Math.max(1_000, Math.floor(deadline.idleMs / 4));
  const timer = setInterval(() => {
    const size = sizeOf();
    if (size !== lastSize) {
      lastSize = size;
      lastChangeAt = Date.now();
      return;
    }
    if (Date.now() - lastChangeAt < deadline.idleMs) return;
    clearInterval(timer);
    fired = true;
    // SIGTERM, as a human would: the child gets its chance to flush and exit,
    // and the exit classification below reports the turn as failed either way.
    proc.kill();
  }, every);
  // The interval must not hold the process open when nothing else is pending.
  (timer as unknown as { unref?: () => void }).unref?.();
  return { fired: () => fired, stop: () => clearInterval(timer) };
};

/** Run a recipe argv to completion, typed. A spawn that cannot even start
 *  (missing executable -> synchronous throw) is `spawn-failed` rather than a
 *  throw, so one bad recipe never crashes the caller. Shared by the fork
 *  launcher, the hub's create, and the attend engine so every spawner carries
 *  the same identity + logging discipline. */
export const runSpawn = async (
  argv: string[],
  cwd: string,
  logFile: string,
  identity?: SpawnIdentity,
  deadline?: SpawnDeadline,
): Promise<SpawnResult> => {
  const discovered = identity?.strategy?.source === "stdout-jsonl";
  // The child is its OWN harness session: inheriting the launcher's
  // LUCID_SESSION_ID would stamp the child's events as the parent
  // conversation (D18 misattribution). Model/effort follow the same rule -
  // the child stamps what IT runs (the applied selection), never what the
  // spawning process happened to inherit. A DISCOVERED harness goes one
  // further: even a caller-supplied id is cleared, because the harness mints
  // its own and a pre-minted UUID in the child's env is exactly the synthetic
  // identity that poisoned resume.
  // The env mapping lives in env-stamp.ts (M5.5): one table both the
  // spawn writer and the ack reader import. buildSpawnEnv sets each
  // LUCID_* from the identity or clears them all when no identity is passed.
  const env = buildSpawnEnv(
    identity
      ? {
          harness: identity.harness,
          ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
          ...(identity.strategy && identity.sessionId && !discovered
            ? { sessionIdAuthority: "assigned" }
            : {}),
          ...(identity.launchId !== undefined ? { launchId: identity.launchId } : {}),
          ...(identity.model !== undefined ? { model: identity.model } : {}),
          ...(identity.effort !== undefined ? { effort: identity.effort } : {}),
          ...(identity.requestId !== undefined ? { requestId: identity.requestId } : {}),
          ...(identity.turnId !== undefined ? { turnId: identity.turnId } : {}),
        }
      : null,
    discovered,
    identity?.hubPort,
  );
  // The out-log is machine-local (plan 02); its `run/` parent may not exist
  // yet when a fork's create turn spawns. mkdir defensively - idempotent.
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  let observed: NativeSessionIdentity | undefined;
  let callbackDone: Promise<void> | undefined;
  // Wrapped so a SYNCHRONOUS throw from the callback is a settled rejection
  // (Promise.resolve(fn()) would let it escape into the tee loop), and so the
  // swallow is in one place.
  const fireDiscovery = (found: NativeSessionIdentity): void => {
    observed = found;
    callbackDone = (async () => identity?.onIdentityDiscovered?.(found))()
      .then(() => undefined)
      .catch(() => {});
  };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      // Discovery taps stdout THROUGH the parent: the same bytes continue to
      // the log fd untouched, chunk boundaries and all. Stderr stays wired
      // straight to the log - it is logged evidence, never identity.
      stdout: discovered ? "pipe" : fd,
      stderr: fd,
    });
  } catch {
    // ONLY a spawn that could not start (missing executable) is spawn-failed:
    // this catch is deliberately narrow, because labeling a mid-stream error
    // "spawn-failed" told the caller to retry against a child that was still
    // running - two concurrent turns driving one conversation.
    try {
      closeSync(fd);
    } catch {
      /* fd already closed */
    }
    return { code: 127, status: "spawn-failed" };
  }
  try {
    if (discovered && identity?.strategy?.source === "stdout-jsonl" && proc.stdout) {
      try {
        const decoder = new SessionIdentityDecoder(identity.harness, identity.strategy);
        const text = new TextDecoder();
        for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          writeSync(fd, chunk);
          if (observed) continue; // first announcement wins; the rest is output
          // stream:true so a multibyte character split across chunks decodes
          // whole instead of as replacement bytes inside a JSONL line.
          for (const event of decoder.push(text.decode(chunk, { stream: true }))) {
            if (!observed) fireDiscovery(event.identity);
          }
        }
        if (!observed) {
          const event = decoder.finish()[0];
          if (event) fireDiscovery(event.identity);
        }
      } catch {
        // The TEE broke (out-log ENOSPC, stream error) - not the child. The
        // child cannot be left running with nobody draining its stdout: kill
        // it, and let the exit classification below tell the truth about a
        // turn this parent had to abandon.
        proc.kill();
      }
    }
    const stalled = watchForStall(proc, logFile, deadline);
    await proc.exited;
    stalled.stop();
    // The callback's work is bounded elsewhere too (sidecar locks time out),
    // but its HTTP leg is not - and a wedged hub must not wedge every future
    // turn of this session behind an await that cannot settle.
    if (callbackDone) {
      await Promise.race([callbackDone, new Promise((r) => setTimeout(r, 10_000))]);
    }
    // A signal-killed child has no exit code; it is anything but clean.
    const code = proc.exitCode ?? (proc.signalCode !== null ? 1 : 0);
    // A stall needs EVIDENCE the kill took effect, not just that the timer
    // fired: a child that flushed and exited 0 in the same beat the watchdog
    // armed was a completed turn, and reporting it stalled would discard work
    // that actually landed.
    const wasStalled = stalled.fired() && code !== 0;
    if (identity?.strategy) {
      const classified = classifySpawnResult(code, identity.strategy, observed);
      // A killed child is a failed turn whatever the classifier made of its
      // (absent) output, and the stall is the part worth reporting: it says
      // the SESSION is unusable here, not that the feedback was bad.
      if (!wasStalled) return classified;
      return {
        code: classified.code || 1,
        ...("identity" in classified && classified.identity
          ? { identity: classified.identity }
          : {}),
        stalled: true,
        status: "process-failed",
      };
    }
    // Legacy recipe: no declaration, no discovery - a clean exit is complete
    // (nothing was promised), a bad one is a process failure.
    return code === 0 ? { code: 0, status: "completed" } : { code, status: "process-failed" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed */
    }
  }
};

/**
 * The ONE discovery-persistence callback (plan 03, M3): every spawner that
 * taps stdout hands runSpawn this, so what happens to an announced identity
 * cannot differ by call site. A CREATE launch takes whatever arrives; a
 * RESUME launch guards with the mismatch policy first - an announcement that
 * names a DIFFERENT session than requested is HSI005, and binding it would
 * attach the review to a conversation that never saw the artifact. The
 * refusal is silent here; the failure surface (warning codes, quarantine)
 * is the recovery milestone's.
 */
export const discoveryPersistence =
  (
    target: SessionPaths,
    harness: string,
    launchId: string,
    guard?: { readonly requestedSessionId: string; readonly allowRotation: boolean },
  ): ((identity: NativeSessionIdentity) => Promise<void>) =>
  async (identity) => {
    if (guard) {
      const outcome = classifyObservedIdentity(
        guard.requestedSessionId,
        identity,
        guard.allowRotation,
      );
      if (outcome.status === "mismatch") return;
    }
    await recordPendingIdentity(target, {
      harness,
      sessionId: identity.sessionId,
      sessionIdAuthority: identity.authority,
      launchId,
    });
    // Promotion is live-aware and idempotent: if the session is already open
    // the binding lands NOW through the locked path; if not, the sidecar
    // keeps owing it and the child's own `lucid open` promotes.
    await promotePendingBindings(target).catch(() => {});
  };

/**
 * The ONE spawn-identity setup (plan 03, M3): resolve the adapter's declared
 * strategy (HSI001 before any process exists when there is none), mint the
 * launch correlation, assign the native id when the strategy is
 * caller-assigned, and bind the persistence callback that records discovered
 * identity against the target session. Fork create and hub create ride it
 * whole; the resume paths (attend, child revise) mint per-turn launches but
 * share `discoveryPersistence`, so the part that can poison a record - what
 * happens to an announced identity - has exactly one implementation.
 */
export const prepareSpawnIdentity = (
  harness: string,
  recipe: SpawnRecipe | undefined,
  registryFile: string,
): {
  readonly launchId: string;
  readonly strategy: SessionIdentityRecipe;
  /** The `{id}` argv substitution for caller-assigned strategies; discovered
   *  harnesses mint their own and get none from us. */
  readonly assignedSessionId?: string;
  /** The runSpawn identity for a launch targeting `target`, with discovery
   *  persistence wired: an announced identity lands in the target's sidecar
   *  (pending) and is promoted through the locked path immediately - the
   *  sidecar knows before the turn can end. */
  readonly identityFor: (target: SessionPaths, extra?: Partial<SpawnIdentity>) => SpawnIdentity;
  /** Record a caller-assigned identity as pending against the target BEFORE
   *  spawning - it is known already, and a child that crashes pre-open must
   *  still leave a resumable record. No-op for discovered strategies. */
  readonly recordAssigned: (target: SessionPaths) => Promise<void>;
} => {
  const strategy = requireSessionIdentity(harness, recipe, registryFile);
  const launchId = mintLaunchId();
  const assignedSessionId = strategy.source === "caller-assigned" ? crypto.randomUUID() : undefined;
  const identityFor = (target: SessionPaths, extra?: Partial<SpawnIdentity>): SpawnIdentity => ({
    harness,
    launchId,
    strategy,
    ...(assignedSessionId ? { sessionId: assignedSessionId } : {}),
    onIdentityDiscovered: discoveryPersistence(target, harness, launchId),
    ...extra,
  });
  /** An ASSIGNED identity is known before the process exists: record it
   *  pending immediately, so even a child that crashes pre-open leaves a
   *  resumable record - and the same promotion path lands its binding. */
  const recordAssigned = async (target: SessionPaths): Promise<void> => {
    if (!assignedSessionId) return;
    await recordPendingIdentity(target, {
      harness,
      sessionId: assignedSessionId,
      sessionIdAuthority: "assigned",
      launchId,
    });
  };
  return {
    launchId,
    strategy,
    ...(assignedSessionId ? { assignedSessionId } : {}),
    identityFor,
    recordAssigned,
  };
};
