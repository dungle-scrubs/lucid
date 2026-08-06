import {
  artifactAttendant,
  readAttendantSidecars,
  recordSessionInvalidation,
  resolveResumeCandidates,
  type ResumeCandidate,
} from "../core/attendant.ts";
import type { FoldedState } from "../core/fold.ts";
import { harnessSessionCwd, harnessSessionId, harnessStoreHas } from "../core/harness-store.ts";
import type { SessionPaths } from "../core/paths.ts";
import { scratchpadProject } from "../core/scratchpad.ts";

/**
 * attend-candidates - the resume-candidate ladder, the verdict cache, and the
 * durable quarantine for the attend engine.
 *
 * Owns:
 *   - {@link attendCandidates} / {@link attendTarget}: gathering the ranked
 *     resume candidates for an artifact and reducing them to the single target
 *     a batch drives - the primary id, the one permitted fallback, and the
 *     "every recorded session is gone" (exhausted) verdict.
 *   - {@link createVerdictCache}: the batch-local "ruled out" set with an
 *     injectable clock and cooloff. A verdict retires an id within a batch and
 *     expires with the cooloff; the set resets only when the batch boundary
 *     moves, so verdicts neither leak across batches nor reset within one.
 *   - {@link quarantineSession}: the ONE entry point that writes a durable
 *     on-disk invalidation AND retires the id in the cache, swallowing the
 *     disk failure - a quarantine that threw would strand feedback behind a
 *     sidecar that cannot be written.
 *
 * Does NOT own:
 *   - the delivery decision (attendDecision/attendReason - pure policy, in
 *     attend.ts) or the turn spawn itself (driveTurn, in attend.ts).
 *   - the trust-ladder ranking, which lives in core/attendant.ts
 *     (resolveResumeCandidates); this module gathers its inputs and consumes
 *     its output.
 */

/** A session id retired for the current batch, with the clock that expires it. */
export interface VerdictCache {
  /** True when `id` is retired for the current batch and its cooloff has not
   *  elapsed. An expired entry is dropped on read. */
  readonly isRuledOut: (id: string) => boolean;
  /** Retire `id` for the current batch (and the cooloff window). */
  readonly ruleOut: (id: string) => void;
  /** Adopt `deliveredFrom` as the current batch boundary, clearing the set
   *  when it moved. A no-op when the boundary is unchanged, so a batch in
   *  flight keeps its verdicts. */
  readonly advanceBatch: (deliveredFrom: number) => void;
}

export interface VerdictCacheOptions {
  /** How long a rule-out holds before the verdict is re-tested. */
  readonly cooloffMs: number;
  /** Injectable clock; production passes `() => Date.now()`, tests a stub. */
  readonly now: () => number;
}

/**
 * The verdict cache driveTurn carries across ticks. Replaces the inline
 * `ruledOutForBatch` map and its batch-boundary check; behavior is identical,
 * with the clock made injectable so cooloff expiry is unit-testable.
 */
export const createVerdictCache = (options: VerdictCacheOptions): VerdictCache => {
  const { cooloffMs, now } = options;
  let batchFrom = -1;
  let ruledOutForBatch = new Map<string, number>();
  return {
    isRuledOut: (id) => {
      const at = ruledOutForBatch.get(id);
      if (at === undefined) return false;
      if (now() - at < cooloffMs) return true;
      ruledOutForBatch.delete(id);
      return false;
    },
    ruleOut: (id) => {
      ruledOutForBatch.set(id, now());
    },
    advanceBatch: (deliveredFrom) => {
      if (deliveredFrom !== batchFrom) {
        batchFrom = deliveredFrom;
        ruledOutForBatch = new Map<string, number>();
      }
    },
  };
};

/**
 * Quarantine a session id durably: write the on-disk invalidation (so a
 * restart does not resurrect it) and retire it in the cache (so the rest of
 * this batch does not retry it). The disk write is best-effort - a quarantine
 * that threw would strand feedback behind an unwritable sidecar, so a failure
 * is swallowed and the local rule-out still holds for the batch.
 *
 * The single entry point for the HSI004 (session-not-found) verdict; the
 * pre-flight and stalled branches retire an id locally only and call
 * `cache.ruleOut` directly.
 */
export const quarantineSession = async (
  paths: SessionPaths,
  harness: string,
  sessionId: string,
  cache: VerdictCache,
): Promise<void> => {
  cache.ruleOut(sessionId);
  await recordSessionInvalidation(paths, harness, sessionId).catch(() => {
    /* a missing/unwritable sidecar must not strand the batch; the local
     * rule-out above already holds for this batch. */
  });
};

/**
 * Where a resume can actually FIND the session. `claude --resume <id>` looks
 * the session up under the project of the directory it runs in, so for an
 * artifact in an agent scratchpad the only workable cwd is the one the
 * scratchpad path encodes - never the scratchpad itself, and never a cwd
 * recorded from inside it.
 */
const resumeCwd = async (
  paths: SessionPaths,
  sessionId: string | undefined,
  recorded?: string,
): Promise<{ readonly cwd?: string }> => {
  const filed = sessionId ? await harnessSessionCwd(sessionId) : undefined;
  const decoded = filed ?? (await scratchpadProject(paths.artifactDir));
  const cwd = decoded ?? recorded;
  return cwd ? { cwd } : {};
};

/**
 * The ranked resume candidates for this artifact (plan 03, M4): sidecars with
 * explicit authority, corroborated durable bindings, one id a harness-specific
 * parser pulled from the recorded resume command, and a corroborated
 * scratchpad id - gathered here and ranked by core/attendant.ts.
 *
 * `recorded` is the artifact's recorded association (from {@link
 * artifactAttendant}); it supplies the legacy resume command and the harness a
 * scratchpad id belongs to, and is read once so ranking and placement share
 * the same view.
 */
export const attendCandidates = async (
  paths: SessionPaths,
  state: FoldedState,
  recorded: Awaited<ReturnType<typeof artifactAttendant>>,
): Promise<readonly ResumeCandidate[]> => {
  const sidecars = await readAttendantSidecars(paths);
  const scratchpadId = harnessSessionId({ artifactDir: paths.artifactDir });
  // The recorded resume COMMAND comes from the sidecars directly, not from
  // `artifactAttendant`: that resolver answers "who owns this artifact" and
  // returns early on a stamped id, carrying no resume string - so reading the
  // command through it made tier 3 vanish for the artifacts that followed the
  // integration guide most completely. Newest sidecar that has one wins.
  const resumeSidecar = [...sidecars]
    .filter((a) => a.resume !== undefined)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  const harnessForScratchpad = resumeSidecar?.harness ?? recorded?.harness;
  return resolveResumeCandidates({
    sidecars,
    bindings: state.bindings,
    corroborate: (harness, sessionId) => harnessStoreHas(harness, sessionId),
    ...(resumeSidecar?.resume
      ? { legacyResume: { command: resumeSidecar.resume, harness: resumeSidecar.harness } }
      : {}),
    ...(scratchpadId && harnessForScratchpad
      ? { scratchpad: { harness: harnessForScratchpad, sessionId: scratchpadId } }
      : {}),
  });
};

/** The target a single delivery batch drives. */
export interface AttendTarget {
  readonly harness: string;
  /** Absent when nothing PROVEN resumable exists: the artifact is still
   *  attendable - by a fresh handoff, which resumes nothing. */
  readonly sessionId?: string;
  readonly cwd?: string;
  /** The one permitted weaker candidate (D-004): a distinct id of the same
   *  harness, resolved now so a not-found on the primary needs no second
   *  resolution pass. */
  readonly fallback?: { readonly harness: string; readonly sessionId: string };
  /** Every candidate this artifact had was proven dead on this machine: a
   *  fresh handoff would answer a question nobody asked. */
  readonly exhausted?: boolean;
}

/**
 * Reduce an artifact's ranked candidates to the one target this batch drives:
 * the best candidate, its cwd, the single permitted fallback, and - when no
 * candidate survives but a harness is recorded - the exhausted verdict that
 * tells the engine to stand down rather than silently start a stranger.
 *
 * Returns undefined when no harness is recorded at all (nothing to resume and
 * nothing to hand off to).
 */
export const attendTarget = async (
  paths: SessionPaths,
  state: FoldedState,
): Promise<AttendTarget | undefined> => {
  const recorded = await artifactAttendant(paths, state.sessionHistory);
  const candidates = await attendCandidates(paths, state, recorded);
  const best = candidates[0];
  if (!best) {
    if (!recorded?.harness) return undefined;
    const quarantined = (await readAttendantSidecars(paths)).some(
      (a) => (a.invalidatedSessionIds ?? []).length > 0,
    );
    return {
      harness: recorded.harness,
      ...(quarantined ? { exhausted: true } : {}),
      ...(await resumeCwd(paths, undefined, recorded.cwd)),
    };
  }
  const next = candidates.find((c) => c.sessionId !== best.sessionId && c.harness === best.harness);
  return {
    harness: best.harness,
    sessionId: best.sessionId,
    ...(await resumeCwd(paths, best.sessionId, recorded?.cwd)),
    ...(next ? { fallback: { harness: next.harness, sessionId: next.sessionId } } : {}),
  };
};
