import { describe, expect, test } from "bun:test";
import { swr } from "../src/core/swr.ts";

/**
 * The cache the hub's session listing is served from. Its whole job is what
 * happens while a computation is SLOW, so every test here holds one open.
 */
describe("serve the last answer while computing the next", () => {
  /** A compute whose completion the test decides, one release per call. */
  const gated = <T>(): {
    compute: () => Promise<T>;
    release: (value: T) => void;
    calls: () => number;
  } => {
    let calls = 0;
    const pending: Array<(value: T) => void> = [];
    return {
      compute: () => {
        calls += 1;
        return new Promise<T>((r) => pending.push(r));
      },
      release: (value) => pending.shift()?.(value),
      calls: () => calls,
    };
  };

  test("a cold cache waits; a warm one answers while the next is computed", async () => {
    const g = gated<string>();
    const c = swr(g.compute);

    // Cold: there is nothing to serve, so the caller waits. Anything else
    // would be inventing an answer.
    const first = c.cached();
    g.release("one");
    expect(await first).toBe("one");

    // Warm: the previous answer comes back immediately even though the refresh
    // this call started is still running.
    expect(await c.cached()).toBe("one");
    expect(g.calls()).toBe(2);
    // And the next reader gets what that refresh produced.
    g.release("two");
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.cached()).toBe("two");
  });

  test("concurrent readers share ONE computation", async () => {
    const g = gated<number>();
    const c = swr(g.compute);
    const cold = Promise.all([c.cached(), c.cached(), c.cached()]);
    // A machine already short of I/O must not get three walks of the same tree
    // because three tabs asked at once.
    expect(g.calls()).toBe(1);
    g.release(7);
    expect(await cold).toEqual([7, 7, 7]);

    // Warm, and the same: the readers served from cache kick one refresh
    // between them, not one each.
    expect(await Promise.all([c.cached(), c.cached(), c.cached()])).toEqual([7, 7, 7]);
    expect(g.calls()).toBe(2);
  });

  /**
   * The property `fresh` exists for: a caller asks because something CHANGED,
   * so an answer computed before the change is the old world under a new name.
   * Joining the walk already in flight - what single flight would do on its
   * own - is exactly that mistake.
   */
  test("`fresh` never returns a value computed before it was called", async () => {
    const g = gated<string>();
    const c = swr(g.compute);
    const warming = c.fresh(); // a walk begins...
    const asked = c.fresh(); // ...and only now does the world change
    g.release("before");
    expect(await warming).toBe("before");
    // The second caller waited for that walk rather than racing it, then took
    // the one after it.
    g.release("after");
    expect(await asked).toBe("after");
    expect(g.calls()).toBe(2);
  });

  test("a failed refresh reaches its caller and leaves the last good value", async () => {
    let attempt = 0;
    const c = swr(async () => {
      attempt += 1;
      if (attempt === 2) throw new Error("scan blew up");
      return `ok-${attempt}`;
    });
    expect(await c.fresh()).toBe("ok-1");
    // The error is the awaiting caller's to handle...
    await expect(c.fresh()).rejects.toThrow("scan blew up");
    // ...and the cache still holds what worked: a listing that fails once must
    // not blank a shell.
    expect(await c.cached()).toBe("ok-1");
  });

  test("a background refresh that fails never becomes an unhandled rejection", async () => {
    let attempt = 0;
    const c = swr(async () => {
      attempt += 1;
      if (attempt > 1) throw new Error("later scans fail");
      return "first";
    });
    expect(await c.fresh()).toBe("first");
    // `cached` starts a refresh it does not await; that rejection is swallowed
    // deliberately, because nobody is on the other end of it.
    expect(await c.cached()).toBe("first");
    await new Promise((r) => setTimeout(r, 5));
    expect(await c.cached()).toBe("first");
  });

  /**
   * `invalidate` is for a caller that changed the SOURCES - the hub adding a
   * scan root. A walk already under way is reading the old ones, so if it were
   * allowed to land as the cached answer, the next reader would be told the
   * folder they just added holds nothing.
   */
  test("a walk that started before `invalidate` never becomes the answer", async () => {
    const g = gated<string>();
    const c = swr(g.compute);

    const stale = c.fresh(); // walking the OLD sources
    c.invalidate(); // a root is added
    const after = c.cached(); // the next reader must not be handed that walk
    // ...and must not race it either: the machine that needs this cache is the
    // one where two walks of the same tree at once is the original problem.
    expect(g.calls()).toBe(1);

    g.release("old-roots"); // the pre-change walk lands...
    expect(await stale).toBe("old-roots"); // ...for the caller that asked for it
    await new Promise((r) => setTimeout(r, 0));
    expect(g.calls()).toBe(2); // only now does the next walk begin
    g.release("new-roots");
    expect(await after).toBe("new-roots");
    // And the discarded walk did not leave its answer behind for the next read.
    expect(await c.cached()).toBe("new-roots");
  });

  /**
   * Without a floor, a read starts a walk the moment the previous one lands,
   * so a busy disk simply never stops walking - and when something else
   * already refreshes on a timer, not one of those walks buys any freshness.
   */
  test("`minAgeMs` declines to re-walk behind a value that is still young", async () => {
    const g = gated<string>();
    const c = swr(g.compute, { minAgeMs: 10_000 });

    const first = c.cached();
    g.release("one");
    expect(await first).toBe("one");

    // Served, and NO refresh kicked behind it.
    expect(await c.cached()).toBe("one");
    expect(await c.cached()).toBe("one");
    expect(g.calls()).toBe(1);

    // The floor never applies to a caller who says the world moved.
    const asked = c.fresh();
    expect(g.calls()).toBe(2);
    g.release("two");
    expect(await asked).toBe("two");
  });
});
