import type { AgentWorking } from "../../src/protocol/wire.ts";

/**
 * When an open turn stops counting as work in progress.
 *
 * Ten minutes with nothing said. Long enough that a turn thinking through one
 * expensive tool call is not called dead, short enough that a human is not
 * watching a spinner for an hour over a process that exited. Nothing here ends
 * the turn - the log is the only thing that can do that - this only governs
 * what the viewer is entitled to claim while the turn stays open.
 */
export const WORKING_STALE_MS = 10 * 60 * 1000;

export interface WorkingClock {
  /** Since delivery: what the human has been waiting, which is what they care
   *  about and what the elapsed timer shows. */
  readonly elapsedMs: number;
  /** Since the agent last said anything. The liveness question. */
  readonly quietMs: number;
  readonly stale: boolean;
  /** Whole minutes and seconds of `elapsedMs`, for the timer. */
  readonly mm: number;
  readonly ss: string;
}

/**
 * How long this turn has been running, and whether it still sounds alive.
 *
 * Staleness is measured from the LAST ACK, not from the turn's start. Measured
 * from the start, a fan-out that narrates its phases for twenty minutes goes
 * "stale" mid-sentence while actively reporting, and a turn whose process died
 * thirty seconds in looks healthy for the rest of the window. The heartbeat is
 * the only signal that separates those, so it is the one the clock reads;
 * `since` remains what the human is shown, because their wait started there.
 *
 * `heardAt` is optional on the wire (an older server omits it) - falling back
 * to `since` reproduces exactly the previous behaviour rather than declaring
 * every turn fresh.
 */
export const workingClock = (working: AgentWorking, now: number): WorkingClock => {
  const started = new Date(working.since).getTime();
  const heard = working.heardAt ? new Date(working.heardAt).getTime() : started;
  const elapsedMs = Math.max(0, now - started);
  const quietMs = Math.max(0, now - heard);
  return {
    elapsedMs,
    quietMs,
    stale: quietMs >= WORKING_STALE_MS,
    mm: Math.floor(elapsedMs / 60000),
    ss: String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, "0"),
  };
};
