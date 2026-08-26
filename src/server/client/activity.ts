/**
 * What the dock says the agent is doing, and when that becomes an alarm.
 *
 * The page used to call a turn stalled after 45 seconds of an unchanged
 * transcript. Both halves of that were wrong, and `live1`'s log shows why.
 *
 * A turn appends nothing between its input and its terminal event: the
 * disposition lands at +0.1s and the message and `done` arrive together at
 * +19s, with no line in between. So "the transcript changed" is not a
 * heartbeat, and its absence is not silence.
 *
 * And the same log has a 1315-second gap between a save and the next note,
 * because a person was reading. Time-since-the-transcript-changed was
 * already twenty-two minutes when the next turn started, so the alarm fired
 * on the first tick of work that was going fine.
 *
 * What is measured here is how long THIS stretch of work has been running.
 */

/** Below this the number is noise, and a dock that counts every wait
 * teaches you to stop reading it. */
export const ELAPSED_VISIBLE_AFTER = 20;

/** When a running turn becomes an alarm. A document revision on this record
 * was measured at 127 seconds, so the threshold sits well past the slowest
 * work actually seen. An alarm that fires on normal work is not an alarm.
 * RFC-08 is the change that makes revisions short; this number comes down
 * with it, not before. */
export const TURN_STALL_AFTER = 300;

/** When notes nobody has taken become an alarm. Nothing has to run for a
 * note to be delivered, so silence here means no driver picked it up, and
 * that is worth saying much sooner than a slow turn is. */
export const UNDELIVERED_STALL_AFTER = 45;

export interface Activity {
  readonly turn: boolean;
  /** Delivered inputs whose turn has produced no terminal event. */
  readonly inFlight: number;
  /** Written but not delivered to anyone. */
  readonly waiting: number;
}

export interface Report {
  /** Whether the dock shows anything at all. */
  readonly busy: boolean;
  /** Whether what it shows is an alarm. */
  readonly stalled: boolean;
  /** What is happening, in words. */
  readonly label: string;
  /** How long, or null when it is too soon to be worth saying. */
  readonly elapsed: string | null;
}

/** Seconds, until minutes read better. A three-digit second count is a
 * number you have to convert before you can judge it. */
export const formatElapsed = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 90) return `${whole}s`;
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
};

/**
 * `workingFor` is seconds since this stretch of work began, not since the
 * transcript last changed. The caller owns that clock because only it knows
 * when idle turned into busy.
 */
export const describeActivity = (activity: Activity, workingFor: number): Report => {
  const working = activity.turn || activity.inFlight > 0;
  const busy = working || activity.waiting > 0;
  if (!busy) return { busy: false, stalled: false, label: "", elapsed: null };

  // A turn that is running and a note nobody took are different failures
  // with different patience. Judging them against one threshold is what
  // made the alarm useless: too eager for the turn, too slow for the note.
  const stalled = working ? workingFor > TURN_STALL_AFTER : workingFor > UNDELIVERED_STALL_AFTER;

  const label = activity.turn
    ? "the agent is working"
    : activity.inFlight > 0
      ? `${activity.inFlight} sent, waiting for the agent`
      : `${activity.waiting} written, not delivered yet`;

  return {
    busy: true,
    stalled,
    label,
    // An alarm always says how long. Ordinary work says so once the wait is
    // long enough to wonder about.
    elapsed: stalled || workingFor > ELAPSED_VISIBLE_AFTER ? formatElapsed(workingFor) : null,
  };
};
