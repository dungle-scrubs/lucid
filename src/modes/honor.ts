/**
 * DriverHonor — RFC-12's honor rule, wrapped around the headless host.
 *
 * A headless driver (`lucid2 chat`, `lucid2 run`) reads the record's
 * driver preference before each turn is handed to the harness. When the
 * harness, provider, model or effort it names differ from the flags the
 * current source spawned under - on dimensions an explicit spawn flag did
 * not pin - the driver closes the runner and re-opens under the new flags
 * through the SAME code path a restart uses: a fresh attach (the epoch
 * bump is the existing takeover mechanism), the record replayed, the new
 * harness named on the attach. The conversation continues through session
 * recall - the reducer's per-harness session map answers on attach-ok, and
 * the old harness's session id is never carried across: it names a
 * conversation the new harness never had.
 *
 * Inputs are never lost to a switch. The boundary check fires BEFORE the
 * hand-over, so the input in hand has no applied disposition yet; it stays
 * outstanding in the record, and the replacement source's attach replays
 * it. Inputs that arrive while the switch itself is running are safe the
 * same way: the record holds them until a source answers.
 *
 * A failed re-spawn stops this driver. The selected preference and pending
 * input remain unchanged for explicit recovery (RFC 15).
 *
 * What it is NOT: it never drives an interactive session (that path never
 * builds a headless source; for it the driver line stays a report), and it
 * never writes the preference - the server is the only writer.
 */

import type { HarnessName } from "../harness/runner.js";
import { HarnessRefusal } from "../harness/runner.js";
import type { Frame } from "../protocol/index.js";
import type { DriverPreference } from "../store/driver-preference.js";
import type { createHeadlessHost, HeadlessDeps, SourceChannel, SourceEnd } from "./host.js";

/** What a source was spawned under: the harness plus the dimensions the
 * preference can set. Absent means the hcn default applies. */
export interface DriverSpawn {
  readonly profile?: import("../harness/runner.js").HarnessMode;
  readonly harness: HarnessName;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: string;
}

/** The profile a harness runs - `supportsSession` answers it per harness,
 * injected so this module owns no hcn knowledge beyond the flags. */
export type HeadlessProfile = "headless-session" | "headless-turn";

export interface HonorDeps {
  readonly signal?: AbortSignal;
  readonly validateProcess?: (
    spawn: DriverSpawn,
    profile: HeadlessProfile,
    resume: string | undefined,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly validateSpawn?: (
    spawn: DriverSpawn,
    profile: HeadlessProfile,
    signal: AbortSignal,
  ) => Promise<void>;
  /** The deps every spawn shares (conversation, secret, runner, sendFrame,
   * host seams, turn-id minter). The choice-dependent fields - harness,
   * model, provider, effort, and the honor hooks - are added per spawn. */
  readonly base: Omit<HeadlessDeps, "harness" | "model" | "provider" | "effort">;
  /** Whether a harness holds a persistent session - the same question the
   * startup path asks through `supportsSession`. One inspect per open. */
  readonly sessionCapable: (harness: HarnessName, signal: AbortSignal) => Promise<boolean>;
  /** The harness this driver resolved at startup: explicit spawn flag, else
   * the preference, else the default. The caller reads the preference for
   * this - the startup honor rule - and names the result here. */
  readonly initialHarness: HarnessName;
  /** RFC-12: an explicit harness at spawn (--harness, LUCID_HARNESS) pins
   * the harness for this process's life; the preference never switches it. */
  readonly harnessPinned: boolean;
  /** Reads the record's driver preference, fresh - the store's tolerant
   * read, never throwing on a torn or absent file. */
  readonly readPreference: () => DriverPreference | null;
  /** Mints a session id per session-profile open (one process each). */
  readonly mintSessionId: () => string;
  /** createHeadlessHost or its test fake - the same seam the startup path
   * injects, so a switch opens through the exact code path a restart uses. */
  readonly createHostFn: typeof createHeadlessHost;
  /** RFC-12: called once after every source open lands - the initial
   * spawn and a switch. The new source's attach advanced the
   * durable cursor past its own attach batch: effects the owner's tailer
   * must not re-collect, because the replay inside them already reached
   * the source directly. */
  readonly onSpawn?: () => void;
}

export interface HonoringSource extends SourceChannel {
  readonly settled: Promise<void>;
  /** What is driving right now: the spawn in force, its profile, and
   * whether anything is. Reported, not conflated with the preference. */
  readonly state: () => {
    readonly spawn: DriverSpawn;
    readonly profile: HeadlessProfile;
    readonly ended: boolean;
  };
}

const spawnOf = (
  pref: DriverPreference,
  currentHarness: HarnessName,
  pinned: boolean,
): DriverSpawn => ({
  // Pinned wins on the harness dimension (RFC-12's resolution order: an
  // explicit spawn flag beats the preference and pins the harness for this
  // process's life). The other dimensions still resolve from the
  // preference, and hcn validates them against the pinned harness at
  // spawn - a mismatch refuses, surfaces through the failure path, and
  // costs one error event.
  harness: pinned ? currentHarness : pref.harness,
  ...(pref.profile === undefined ? {} : { profile: pref.profile }),
  ...(pref.model === undefined ? {} : { model: pref.model }),
  ...(pref.provider === undefined ? {} : { provider: pref.provider }),
  ...(pref.effort === undefined ? {} : { effort: pref.effort }),
});

const sameSpawn = (a: DriverSpawn, b: DriverSpawn): boolean =>
  a.harness === b.harness &&
  a.profile === b.profile &&
  a.model === b.model &&
  a.provider === b.provider &&
  a.effort === b.effort;

/**
 * Open the honoring driver: the first source under the folded startup
 * preference, then the boundary rule on top. Resolved when the first
 * source exists; its own open refusal arrives later through onEnded, as
 * it does without honor.
 */
export const openHonoringDriver = async (deps: HonorDeps): Promise<HonoringSource> => {
  // RFC-12 startup honor: the first spawn runs under the preference. The
  // caller names the spine (explicit flag, else the preference's harness,
  // else the default); the preference supplies every other dimension,
  // which no spawn flag expresses.
  const startupPref = deps.readPreference();
  const initial: DriverSpawn =
    startupPref === null
      ? { harness: deps.initialHarness }
      : spawnOf(startupPref, deps.initialHarness, deps.harnessPinned);
  let current = initial;
  let profile: HeadlessProfile = "headless-turn";
  let generation = 0;
  let switching = false;
  const pendingCredits: Extract<Frame, { kind: "credit" }>[] = [];
  const flushCredits = (): void => {
    if (ended) {
      pendingCredits.length = 0;
      return;
    }
    for (const frame of pendingCredits.splice(0)) deliver(frame);
  };
  let pendingSwitch = false;
  let ended = false;
  const cancellation = new AbortController();
  const inspectionSignal = deps.signal
    ? AbortSignal.any([cancellation.signal, deps.signal])
    : cancellation.signal;
  let openingCount = 0;
  const completion = Promise.withResolvers<void>();
  const cleanups = new Set<Promise<void>>();
  let cleanupFailure: unknown;
  const settleIfEnded = (): void => {
    if (ended && openingCount === 0 && cleanups.size === 0) {
      if (cleanupFailure !== undefined) completion.reject(cleanupFailure);
      else completion.resolve();
    }
  };
  void completion.promise.catch(() => {});
  const rememberCleanup = (opened: SourceChannel): void => {
    const pending = opened.settled;
    cleanups.add(pending);
    const complete = (): void => {
      cleanups.delete(pending);
      settleIfEnded();
    };
    void pending.then(complete, (cause: unknown) => {
      cleanupFailure ??=
        cause instanceof Error ? cause : new Error("Source cleanup failed", { cause });
      complete();
    });
  };
  let source: SourceChannel;
  let deliver: (frame: Frame) => void;

  const wantsChange = (): boolean => {
    if (switching || ended) return false;
    const pref = deps.readPreference();
    if (pref === null) return false;
    const desired = spawnOf(pref, current.harness, deps.harnessPinned);
    // Both headless profiles express effort since hcn 0.6.0 grew
    // `hcn session --effort`, so every dimension compares on both.
    return !sameSpawn(desired, current);
  };

  const openUnder = async (
    spawn: DriverSpawn,
    opts: { readonly switched: boolean; readonly notes?: readonly string[] },
  ): Promise<{ readonly source: SourceChannel; readonly profile: HeadlessProfile }> => {
    openingCount++;
    try {
      if (inspectionSignal.aborted)
        throw new HarnessRefusal("aborted", "Driver start was cancelled");
      const gen = ++generation;
      const session = await deps.sessionCapable(spawn.harness, inspectionSignal);
      if (spawn.profile === "interactive")
        throw new HarnessRefusal(
          "unsupported-profile",
          "Interactive mode needs a human-owned terminal session. Choose a headless mode to start here.",
        );
      if (spawn.profile === "headless-session" && !session)
        throw new HarnessRefusal(
          "unsupported-profile",
          "This harness cannot run headless-session. Choose a supported mode.",
        );
      const nextProfile: HeadlessProfile =
        spawn.profile ?? (session ? "headless-session" : "headless-turn");
      if (deps.validateSpawn) await deps.validateSpawn(spawn, nextProfile, inspectionSignal);
      if (ended || inspectionSignal.aborted) throw new Error("Driver closed before source start");
      const validateProcess = deps.validateProcess;
      const host: HeadlessDeps = {
        ...deps.base,
        ...(validateProcess === undefined
          ? {}
          : {
              beforeProcess: (resume: string | undefined, signal: AbortSignal) =>
                validateProcess(spawn, nextProfile, resume, signal),
            }),
        harness: spawn.harness,
        ...(spawn.model === undefined ? {} : { model: spawn.model }),
        ...(spawn.provider === undefined ? {} : { provider: spawn.provider }),
        ...(spawn.effort === undefined ? {} : { effort: spawn.effort }),
        driverChangeAtBoundary: wantsChange,
        onEnded: (end: SourceEnd) => handleEnded(gen, end),
        notes: opts.notes ?? (opts.switched ? [] : deps.base.notes),
        ...(opts.switched ? { probeFirstTurn: true } : {}),
      };
      const opened: SourceChannel =
        nextProfile === "headless-session"
          ? deps.createHostFn({ ...host, sessionId: deps.mintSessionId() }, "headless-session")
          : deps.createHostFn(host, "headless-turn");
      rememberCleanup(opened);
      return { source: opened, profile: nextProfile };
    } finally {
      openingCount--;
      settleIfEnded();
    }
  };

  const switchTo = async (): Promise<void> => {
    if (switching || ended) {
      if (switching) pendingSwitch = true;
      return;
    }
    switching = true;
    const pref = deps.readPreference();
    const desired = pref === null ? current : spawnOf(pref, current.harness, deps.harnessPinned);
    try {
      const opened = await openUnder(desired, { switched: true });
      if (ended) {
        opened.source.close();
        return;
      }
      // The replaced source's pump has already ended - its driver-change
      // ended it - but only close() releases what close() releases. It is
      // idempotent, and the successor is already attached.
      try {
        source.close();
      } catch {}
      current = desired;
      profile = opened.profile;
      source = opened.source;
      deliver = opened.source.receive;
      deps.onSpawn?.();
    } catch (cause) {
      if (ended) return;
      current = desired;
      ended = true;
      pendingCredits.length = 0;
      try {
        source.close();
      } catch {}
      deps.base.onEnded?.({
        kind: "open-refused",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      switching = false;
      settleIfEnded();
      flushCredits();
      if (pendingSwitch && !ended) {
        pendingSwitch = false;
        void switchTo();
      }
    }
  };

  const handleEnded = (gen: number, end: SourceEnd): void => {
    // Only the current source's end is acted on. A source the wrapper has
    // already replaced may report its own end late (a session closing its
    // pipe after the successor attached); its epoch is stale and the
    // reducer has already fenced it.
    if (gen !== generation || ended) return;
    if (end.kind === "store-failed") {
      ended = true;
      pendingCredits.length = 0;
      deps.base.onEnded?.(end);
      settleIfEnded();
      return;
    }
    if (end.kind === "driver-change") {
      void switchTo();
      return;
    }
    // A plain end: the harness stream closed. Nothing re-opens - that is
    // the existing behavior for a driver whose harness died, and the
    // record already says the session ended.
    ended = true;
    deps.base.onEnded?.(end);
    settleIfEnded();
  };

  const opened = await openUnder(initial, { switched: false });
  source = opened.source;
  profile = opened.profile;
  deliver = opened.source.receive;
  try {
    deps.onSpawn?.();
  } catch (cause) {
    ended = true;
    try {
      source.close();
    } catch {
      // Keep the startup failure; cleanup cannot replace its cause.
    } finally {
      await source.settled.catch(() => {});
    }
    throw cause;
  }

  // A preference written while this driver was starting is honored at the
  // first boundary like any other change - not folded in here, where it
  // would race the very first hand-over this source makes.

  return {
    settled: completion.promise,
    recordChanged: () => {
      if (!ended && !switching) source.recordChanged?.();
    },
    receive: (frame: Frame): void => {
      if (ended) return;
      // Inputs are replayed from the record after attach. Credits have no replay.
      if (switching) {
        if (frame.kind === "credit") pendingCredits.push(frame);
        return;
      }
      deliver(frame);
    },
    close: (): void => {
      ended = true;
      cancellation.abort();
      pendingCredits.length = 0;
      try {
        source.close();
      } catch {}
      settleIfEnded();
    },
    busy: () => switching || openingCount > 0 || source.busy?.() === true,
    state: () => ({ spawn: current, profile, ended }),
  };
};
