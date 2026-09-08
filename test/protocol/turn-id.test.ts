/**
 * Turn ids across a restart.
 *
 * A turn id is retired the moment the record has seen it: the reducer refuses
 * `turn-id-reused`, and that rule is what makes a takeover's abort final. So
 * a driver must never mint an id the record already holds.
 *
 * `turn-${++n}` did exactly that. It restarts at `turn-1` on every driver
 * start, so the second driver on a record was refused on its first event and
 * every event after it - while its dispositions kept landing, so it looked
 * alive and recorded nothing the agent said. A record in use ran that way for
 * a day, across four drivers.
 */
import { describe, expect, test } from "bun:test";
import { createTurnIds } from "../../src/protocol/turn-id.js";

describe("minting a turn id", () => {
  test("ids are ordered within one run", () => {
    const mint = createTurnIds("aaaa1111");
    expect([mint(), mint(), mint()]).toEqual([
      "turn-aaaa1111-1",
      "turn-aaaa1111-2",
      "turn-aaaa1111-3",
    ]);
  });

  test("a second run shares no id with the first", () => {
    // The whole defect in one assertion: two drivers on one record.
    const first = createTurnIds();
    const second = createTurnIds();
    const mine = new Set([first(), first(), first()]);
    for (let i = 0; i < 3; i++) expect(mine.has(second())).toBe(false);
  });

  test("many runs collide with none of the others", () => {
    const runs = Array.from({ length: 200 }, () => createTurnIds());
    const seen = new Set<string>();
    for (const mint of runs) {
      for (let i = 0; i < 5; i++) {
        const id = mint();
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(1000);
  });

  test("the counter is still readable in the id", () => {
    // A log full of opaque ids is worse to read than one with an ordinal in
    // it, so uniqueness is added beside the counter rather than instead.
    const mint = createTurnIds();
    expect(mint()).toMatch(/^turn-[0-9a-f]{8}-1$/);
  });
});
