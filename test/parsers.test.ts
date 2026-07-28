import { describe, expect, test } from "bun:test";
import { parseCursor, renderCursor, sliceAfterCursor } from "../src/core/cursor.ts";
import type { LogEvent } from "../src/core/events.ts";
import { foldLog } from "../src/core/fold.ts";
import { sanitizeProgress } from "../src/core/progress.ts";
import { HUB_PORT, parseHubPort } from "../src/server/daemon.ts";

/**
 * The three places Lucid reads a number out of something a human typed: the
 * hub's port out of the environment, a cursor out of `--since`, and fan-out
 * counts out of `lucid progress`.
 *
 * These were e2e scenarios - a hub started three times to watch it not bind a
 * nonsense port, a session driven to seq 3 to ask what `--since 3` means.
 * Moved here per D-018: a scenario that never touches paint does not need a
 * browser. What each one is really asking is what a string parses to, and
 * whether the value survives the fold the viewer reads.
 *
 * What did NOT move: that the hub actually binds the default after a refusal,
 * and that the viewer's indicator paints the folded numbers. Those are claims
 * about a process and a pixel, and they stay in e2e.
 */

describe("the hub's port, out of the environment", () => {
  test("a port that is not spelled in plain digits is not a port", () => {
    // `Number("0x1f")` is 31 and `parseInt("17428garbage")` is 17428. Either
    // would bind, silently, somewhere the human did not ask for - and the only
    // symptom is a shell that cannot find its own hub.
    for (const raw of ["abc", "0x1f", "1e3", "17428garbage", " 17428", "17428 ", "-1", "1.5"]) {
      expect(parseHubPort(raw)).toBeUndefined();
    }
  });

  test("a number outside the TCP range is not a port", () => {
    // 99999 is not addressable. Passed on to `Bun.serve` it fails three layers
    // from the environment variable that caused it.
    expect(parseHubPort("99999")).toBeUndefined();
    expect(parseHubPort("65536")).toBeUndefined();
    expect(parseHubPort("0")).toBeUndefined();
  });

  test("an unset variable is absence, not a refusal", () => {
    expect(parseHubPort(undefined)).toBeUndefined();
    expect(parseHubPort("")).toBeUndefined();
  });

  test("a plain port in range is taken as written", () => {
    expect(parseHubPort("17428")).toBe(17428);
    expect(parseHubPort("1")).toBe(1);
    expect(parseHubPort("65535")).toBe(65535);
  });

  test("every refusal falls back to the default hub port", () => {
    // The whole point of returning `undefined` rather than `NaN` or `0`: the
    // caller's `?? HUB_PORT` has something to land on. `NaN ?? HUB_PORT` is
    // NaN, and NaN reaches `Bun.serve` and `fetch` as a port.
    for (const raw of ["abc", "0x1f", "99999", ""]) {
      expect(parseHubPort(raw) ?? HUB_PORT).toBe(HUB_PORT);
    }
  });
});

const RECORDS = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }];

describe("a cursor, out of --since", () => {
  test("a bare integer is an alias for evt_NNNNN, down to the delta it slices", () => {
    expect(parseCursor("3")).toBe(3);
    expect(parseCursor("evt_00003")).toBe(3);
    // The claim is not just that both parse - it is that `--since 3` and
    // `--since evt_00003` hand the agent the same events.
    expect(sliceAfterCursor(RECORDS, parseCursor("3"))).toEqual([{ seq: 4 }]);
    expect(sliceAfterCursor(RECORDS, parseCursor("3"))).toEqual(
      sliceAfterCursor(RECORDS, parseCursor("evt_00003")),
    );
    // The padding is presentation, not meaning - it is what `renderCursor`
    // adds, and a human retyping the number without it means the same event.
    expect(parseCursor(renderCursor(3))).toBe(3);
    expect(parseCursor("003")).toBe(3);
  });

  test("cursor zero is a cursor, not an absent one", () => {
    // `0` means "before the first event". Read as absent it becomes the
    // bootstrap path instead of a delta, and the agent re-applies the entire
    // session as though it were new feedback.
    expect(parseCursor("0")).toBe(0);
    expect(parseCursor("evt_00000")).toBe(0);
    expect(parseCursor(undefined)).toBeUndefined();
  });

  test("anything that is not a whole number is refused, so wait can say so", () => {
    // `undefined` from a SUPPLIED `--since` is what makes `runWait` throw
    // instead of silently bootstrapping. A lenient parse here turns a typo into
    // a full re-delivery that looks like it worked.
    for (const raw of ["", "  ", "3.5", "-1", "evt_", "evt_x", "evt_00003x", "garbage", "1e3"]) {
      expect(parseCursor(raw)).toBeUndefined();
    }
  });
});

describe("what a cursor still owes the caller", () => {
  const records = RECORDS;

  test("the cursor's own event is not handed back again", () => {
    // Strictly after, never at-or-after. `>=` redelivers the last event on
    // every poll, so an agent looping on `nextCursor` re-applies the same
    // annotation forever.
    expect(sliceAfterCursor(records, 3)).toEqual([{ seq: 4 }]);
    expect(sliceAfterCursor(records, 4)).toEqual([]);
  });

  test("no cursor owes everything - it is the bootstrap read", () => {
    expect(sliceAfterCursor(records, undefined)).toEqual(records);
    expect(sliceAfterCursor(records, 0)).toEqual(records);
  });
});

describe("fan-out counts, from lucid progress to the indicator", () => {
  const ev = (e: Partial<LogEvent> & { t: LogEvent["t"]; seq: number }): LogEvent =>
    ({ at: "2026-01-01T00:00:00Z", ...e }) as LogEvent;

  const opened = ev({
    t: "session_opened",
    seq: 1,
    segment: 1,
    artifact: "a.html",
    version: 1,
    hash: "h",
    path: "versions/s1/v1.html",
  } as never);

  /** One `lucid progress` call, through the boundary that validates it and
   *  into the log the fold reads. `sanitizeProgress` is what both delivery
   *  paths run (the CLI's direct append and the server's ack handler), so this
   *  is the real route a count takes to the viewer. */
  const ack = (seq: number, reported: Record<string, unknown>): LogEvent => {
    const cleaned = sanitizeProgress(reported);
    return ev({ t: "agent_ack", seq, id: `a${seq}`, ...(cleaned ? { progress: cleaned } : {}) });
  };

  test("negative, fractional and non-finite counts never reach the indicator", () => {
    // The reported sequence, one `lucid progress` call per step: open the
    // fan-out, bump `done` with a fraction, then try to set a negative total.
    // After each, what the viewer's indicator would render.
    const start = ack(2, { label: "auditing", total: 7, done: 2 });
    expect(foldLog([opened, start]).agentWorking?.progress).toEqual({
      label: "auditing",
      total: 7,
      done: 2,
    });

    // "3.7 of 7 agents" is not a thing. The indicator renders whatever the
    // fold hands it, so the flooring has to happen before the log.
    const bump = ack(3, { done: 3.7 });
    expect(foldLog([opened, start, bump]).agentWorking?.progress).toEqual({
      label: "auditing",
      total: 7,
      done: 3,
    });

    // A negative total is dropped rather than trusted, and because it is
    // dropped by OMITTING the key, the fold's merge leaves the previous 7
    // standing instead of blanking the denominator.
    const negative = ack(4, { total: -1 });
    const state = foldLog([opened, start, bump, negative]);
    expect(state.agentWorking?.progress).toEqual({ label: "auditing", total: 7, done: 3 });

    // Non-finite gets the same treatment, and never renders as "NaN of 7".
    const nan = ack(5, { done: Number.NaN });
    expect(foldLog([opened, start, bump, negative, nan]).agentWorking?.progress).toEqual({
      label: "auditing",
      total: 7,
      done: 3,
    });
  });

  test("a negative count is dropped, and the previous total stands", () => {
    // Dropped by OMITTING the key, which is the part that matters: the fold
    // merges each ack over the last one, so a sanitizer that returned
    // `{ total: undefined }` would spread that undefined over the good 7 and
    // the indicator would lose the denominator it already had.
    const state = foldLog([
      opened,
      ack(2, { label: "auditing", total: 7, done: 2 }),
      ack(3, { label: "still auditing", total: -1 }),
    ]);
    expect(state.agentWorking?.progress).toEqual({ label: "still auditing", total: 7, done: 2 });
  });

  test("a non-finite count never reaches the log at all", () => {
    // NaN survives JSON only as null, but it arrives as a number from the CLI's
    // own `--done` parse. Serialised into the log it renders as "NaN of 7".
    expect(sanitizeProgress({ total: 7, done: Number.NaN })).toEqual({ total: 7 });
    expect(sanitizeProgress({ total: Number.POSITIVE_INFINITY })).toBeUndefined();

    const state = foldLog([
      opened,
      ack(2, { total: 7, done: 2 }),
      ack(3, { done: Number.NaN, label: "still auditing" }),
    ]);
    expect(state.agentWorking?.progress).toEqual({ label: "still auditing", total: 7, done: 2 });
  });

  test("a report with nothing usable left in it is not written", () => {
    // `--total -1` alone. The ack still lands (it is also a delivery
    // heartbeat), but it carries no progress, so the window keeps the numbers
    // it had rather than showing an empty one.
    expect(sanitizeProgress({ total: -1 })).toBeUndefined();
    const state = foldLog([opened, ack(2, { total: 7, done: 2 }), ack(3, { total: -1 })]);
    expect(state.agentWorking?.progress).toEqual({ total: 7, done: 2 });
  });
});
