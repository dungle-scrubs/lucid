/**
 * Turn ids, unique across process restarts.
 *
 * A turn id is retired the moment the record has seen it: the reducer refuses
 * `turn-id-reused`, and it is right to, because that rule is what makes a
 * takeover's abort final. So a driver MUST NOT mint an id the record already
 * holds.
 *
 * A per-process counter does exactly that. `turn-${++n}` restarts at `turn-1`
 * every time a driver starts, so the second driver on a record is refused on
 * its first event and every event after it. The record keeps accepting its
 * dispositions, so it looks alive while recording nothing the agent says.
 *
 * That is not hypothetical. A record in use had events under one epoch and
 * none under the four that followed - four drivers, deaf from birth, for a
 * day.
 *
 * The counter stays, because a readable id in a log is worth having. What is
 * added is a per-process part that no other process shares.
 */
import { randomUUID } from "node:crypto";

/**
 * A minter for one process. Every id it returns is unique to this process and
 * ordered within it.
 *
 * The shape is `turn-<run>-<n>`: the run part makes it unique, the counter
 * makes it readable and ordered, and both are visible in the log.
 */
export const createTurnIds = (run = randomUUID().slice(0, 8)): (() => string) => {
  let n = 0;
  return () => `turn-${run}-${++n}`;
};
