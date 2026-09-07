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
 * A failed re-spawn keeps the current driver (RFC-12): the input in hand
 * runs on the spawn that was driving, the refusal is recorded as one
 * non-terminal error event worded to name both sides, and the refused
 * preference is remembered so it is not retried on every turn - only after
 * the file changes again.
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
  /** The deps every spawn shares (conversation, secret, runner, sendFrame,
   * host seams, turn-id minter). The choice-dependent fields - harness,
   * model, provider, effort, and the honor hooks - are added per spawn. */
  readonly base: Omit<HeadlessDeps, "harness" | "model" | "provider" | "effort">;
  /** Whether a harness holds a persistent session - the same question the
   * startup path asks through `supportsSession`. One inspect per open. */
  readonly sessionCapable: (harness: HarnessName) => Promise<boolean>;
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
   * spawn, a switch, and a fallback. The new source's attach advanced the
   * durable cursor past its own attach batch: effects the owner's tailer
   * must not re-collect, because the replay inside them already reached
   * the source directly. */
  readonly onSpawn?: () => void;
}

export interface HonoringSource extends SourceChannel {
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

const samePreference = (a: DriverPreference, b: DriverPreference): boolean =>
  a.harness === b.harness &&
  a.profile === b.profile &&
  a.model === b.model &&
  a.provider === b.provider &&
  a.effort === b.effort;

/** `claude`, or `claude/claude-opus-5` when a model is set - the driver
 * in force, named the way the RFC's refusal wording names it. */
const labelOf = (spawn: DriverSpawn): string =>
  spawn.model === undefined ? spawn.harness : `${spawn.harness}/${spawn.model}`;

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
  /** The switch in flight's context: the driver it is leaving (what a
   * failed re-spawn falls back to) and the preference it attempted (what
   * the no-retry rule remembers when that attempt refuses). Null when no
   * switch has opened a replacement yet. */
  let switchCtx: {
    readonly from: DriverSpawn;
    readonly attempted: DriverPreference | null;
  } | null = null;
  /** RFC-12 no-retry: the preference whose re-spawn was refused. It is not
   * re-attempted until the file changes again; the person fixes it with
   * another choice, not with lucid quietly hammering the same one. */
  let refused: DriverPreference | null = null;
  let source: SourceChannel;
  let deliver: (frame: Frame) => void;

  const wantsChange = (): boolean => {
    if (switching || ended) return false;
    const pref = deps.readPreference();
    if (pref === null) return false;
    if (refused !== null && samePreference(pref, refused)) return false;
    const desired = spawnOf(pref, current.harness, deps.harnessPinned);
    // Both headless profiles express effort since hcn 0.6.0 grew
    // `hcn session --effort`, so every dimension compares on both.
    return !sameSpawn(desired, current);
  };

  const openUnder = async (
    spawn: DriverSpawn,
    opts: { readonly switched: boolean; readonly notes?: readonly string[] },
  ): Promise<{ readonly source: SourceChannel; readonly profile: HeadlessProfile }> => {
    const gen = ++generation;
    const session = await deps.sessionCapable(spawn.harness);
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
    const host: HeadlessDeps = {
      ...deps.base,
      harness: spawn.harness,
      ...(spawn.model === undefined ? {} : { model: spawn.model }),
      ...(spawn.provider === undefined ? {} : { provider: spawn.provider }),
      ...(spawn.effort === undefined ? {} : { effort: spawn.effort }),
      driverChangeAtBoundary: wantsChange,
      onEnded: (end: SourceEnd) => handleEnded(gen, end),
      ...(opts.notes === undefined ? {} : { notes: opts.notes }),
      ...(opts.switched ? { probeFirstTurn: true } : {}),
    };
    const opened: SourceChannel =
      nextProfile === "headless-session"
        ? deps.createHostFn({ ...host, sessionId: deps.mintSessionId() }, "headless-session")
        : deps.createHostFn(host, "headless-turn");
    return { source: opened, profile: nextProfile };
  };

  /** Re-open under the driver in force, carrying the refusal wording. The
   * note is the design's rule made real: a consequence with no visual gets
   * words, and the line keeps rendering the driver in force while the
   * menus keep showing the preference - the note says why they differ.
   * `attempted` is the preference the failed spawn ran under: the no-retry
   * memory is the choice that refused, never whatever the file happens to
   * hold now - a person fixing the choice mid-fallback must not have the
   * fix silently suppressed. */
  const fallbackTo = async (
    spawn: DriverSpawn,
    message: string,
    attempted: DriverPreference | null,
  ): Promise<void> => {
    if (attempted !== null) refused = attempted;
    const wasSwitching = switching;
    switching = true;
    try {
      const opened = await openUnder(spawn, {
        switched: false,
        notes: [`driver change refused: ${message}; continuing under ${labelOf(spawn)}`],
      });
      try {
        source.close();
      } catch {}
      source = opened.source;
      profile = opened.profile;
      deliver = opened.source.receive;
      // The driver in force is driving again. If even this spawn refuses
      // to open, there is nothing older to fall back to: the conversation
      // is undrivable from here, which handleEnded answers with ended.
      switchCtx = null;
      deps.onSpawn?.();
    } catch {
      // The driver in force cannot re-open either (attach refused): the
      // conversation is undrivable from here, which is the existing
      // semantics for a source that cannot attach. The record already
      // carries the failed spawns' own error events.
      ended = true;
      deps.base.onEnded?.({ kind: "closed" });
    } finally {
      switching = wasSwitching;
      if (!switching || ended) flushCredits();
    }
  };

  const switchTo = async (): Promise<void> => {
    if (switching || ended) {
      if (switching) pendingSwitch = true;
      return;
    }
    switching = true;
    const pref = deps.readPreference();
    switchCtx = { from: current, attempted: pref };
    const desired = pref === null ? current : spawnOf(pref, current.harness, deps.harnessPinned);
    try {
      const opened = await openUnder(desired, { switched: true });
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
      refused = null;
      deps.onSpawn?.();
      // switchCtx deliberately survives here: the successor's open can
      // still refuse LATE (the session handshake, the turn probe), and the
      // fallback then needs what this switch replaced. It is replaced by
      // the next switch, or cleared when a fallback lands.
    } catch (cause) {
      // openSource itself threw (attach refused, spawn failed before any
      // stream): keep the current driver's arguments and continue on them.
      const from = switchCtx?.from ?? current;
      const attempted = switchCtx?.attempted ?? null;
      switchCtx = null;
      current = from;
      await fallbackTo(from, cause instanceof Error ? cause.message : String(cause), attempted);
    } finally {
      switching = false;
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
      return;
    }
    if (end.kind === "driver-change") {
      void switchTo();
      return;
    }
    if (end.kind === "open-refused") {
      if (switchCtx === null) {
        // The startup spawn or the fallback itself: there is no older
        // driver in force to keep, and its own error event is already in
        // the record - the existing semantics for an open that refuses.
        ended = true;
        deps.base.onEnded?.(end);
        return;
      }
      const ctx = switchCtx;
      switchCtx = null;
      current = ctx.from;
      void fallbackTo(ctx.from, end.message, ctx.attempted);
      return;
    }
    // A plain end: the harness stream closed. Nothing re-opens - that is
    // the existing behavior for a driver whose harness died, and the
    // record already says the session ended.
    ended = true;
    deps.base.onEnded?.(end);
  };

  const opened = await openUnder(initial, { switched: false });
  source = opened.source;
  profile = opened.profile;
  deliver = opened.source.receive;
  deps.onSpawn?.();

  // A preference written while this driver was starting is honored at the
  // first boundary like any other change - not folded in here, where it
  // would race the very first hand-over this source makes.

  return {
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
      pendingCredits.length = 0;
      try {
        source.close();
      } catch {}
    },
    state: () => ({ spawn: current, profile, ended }),
  };
};
