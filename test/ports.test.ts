import { describe, expect, test } from "bun:test";
import { hubPort, portBase, sessionPortPool } from "../src/server/ports.ts";

describe("portBase", () => {
  test("is zero when nothing asks for an offset", () => {
    // The default has to be a true no-op: a developer running one session on
    // their laptop must land on the same ports as before this seam existed,
    // or every bookmark and every Dock-pinned window goes stale.
    expect(portBase({})).toBe(0);
  });

  test("takes LUCID_PORT_BASE when it is set", () => {
    expect(portBase({ LUCID_PORT_BASE: "500" })).toBe(500);
  });

  test("falls back to the Playwright worker index, with worker 0 unshifted", () => {
    // Playwright sets TEST_WORKER_INDEX per worker, so the harness gets
    // isolation without every helper having to compute and thread a base.
    // Worker 0 must land on zero: a single-worker run is the common case and
    // has to behave exactly as it did before this existed.
    expect(portBase({ TEST_WORKER_INDEX: "0" })).toBe(0);
    expect(portBase({ TEST_WORKER_INDEX: "1" })).toBeGreaterThan(0);
    expect(portBase({ TEST_WORKER_INDEX: "3" })).toBe(3 * portBase({ TEST_WORKER_INDEX: "1" }));
  });

  test("an explicit base beats the worker index", () => {
    // A test that pins a port deliberately must not have it moved underneath by
    // whichever worker happened to pick the test up.
    expect(portBase({ LUCID_PORT_BASE: "500", TEST_WORKER_INDEX: "2" })).toBe(500);
  });

  test("nonsense is treated as no offset, not as NaN", () => {
    // A NaN base would silently produce NaN ports and a bind failure nobody
    // could trace back to an environment variable.
    expect(portBase({ LUCID_PORT_BASE: "" })).toBe(0);
    expect(portBase({ LUCID_PORT_BASE: "abc" })).toBe(0);
    expect(portBase({ TEST_WORKER_INDEX: "abc" })).toBe(0);
  });
});

describe("sessionPortPool", () => {
  test("keeps the trailing ephemeral 0 as 0, and shifts the rest", () => {
    // The 0 is not a port, it is "ask the OS for anything free" - the fallback
    // that guarantees a session still starts when every preferred port is
    // taken. Offsetting it would turn the escape hatch into a fixed port that
    // can itself be occupied, which is precisely the failure it exists to
    // prevent, and it would only ever bite under the parallel load this seam
    // was added to enable.
    const shifted = sessionPortPool(20);
    expect(shifted[0]).toBe(17432);
    expect(shifted.at(-1)).toBe(0);
    expect(shifted.filter((p) => p === 0)).toHaveLength(1);
  });

  test("is the untouched pool when the base is zero", () => {
    expect(sessionPortPool(0)).toEqual([17412, 17413, 17414, 17415, 17416, 17417, 17418, 17419, 0]);
  });
});

describe("hubPort", () => {
  test("is 17428 unshifted, and moves with the base", () => {
    expect(hubPort(0)).toBe(17428);
    expect(hubPort(20)).toBe(17448);
  });
});

describe("the property the whole parallel story rests on", () => {
  test("no two workers can ever meet on a port", () => {
    // The reason this seam exists. Everything above is a detail of HOW the
    // offset is computed; this is the thing that has to stay true, and it is
    // what breaks first if anyone widens the pool, adds a second fixed port, or
    // trims the stride. Written as a property over the real worker counts
    // rather than a restatement of the arithmetic, so it fails on a change to
    // any of those rather than needing to be updated alongside it.
    const claimed = new Map<number, number>();
    for (let worker = 0; worker < 8; worker++) {
      const base = portBase({ TEST_WORKER_INDEX: String(worker) });
      // The ephemeral 0 is shared by every worker by design - it is a request,
      // not a port, and the OS hands out a different one each time.
      const ports = [...sessionPortPool(base).filter((p) => p !== 0), hubPort(base)];
      for (const port of ports) {
        const owner = claimed.get(port);
        expect(
          owner,
          `port ${port} wanted by worker ${worker} and already held by worker ${owner}`,
        ).toBeUndefined();
        claimed.set(port, worker);
      }
    }
  });
});
