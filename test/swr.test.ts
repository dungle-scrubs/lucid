import { describe, expect, test } from "bun:test";
import { swr } from "../src/core/swr.ts";

/**
 * The cache the hub's session listing is served from. Its whole job is what
 * happens while a computation is SLOW, so every test here holds one open.
 */
describe("serve the last answer while computing the next", () => {
  /** A compute whose completion the test decides. */
  const gated = <T>(): {
    compute: () => Promise<T>;
    release: (value: T) => void;
    calls: () => number;
  } => {
    let calls = 0;
    let resolve: ((value: T) => void) | undefined;
    return {
      compute: () => {
        calls += 1;
        return new Promise<T>((r) => {
          resolve = r;
        });
      },
      release: (value) => resolve?.(value),
      calls: () => calls,
    };
  };

  test("a cold cache waits; a warm one answers while the next is computed", async () => {
    const g = gated<string>();
    const c = swr(g.compute);

    // Cold: there is nothing to serve, so the caller waits. Anything else
    // would be inventing an answer.
    const first = c.cached();
    expect(c.peek()).toBeUndefined();
    g.release("one");
    expect(await first).toBe("one");

    // Warm: the previous answer comes back immediately even though the refresh
    // this call started is still running - the 40-second scan the shell used
    // to sit through while holding a listing from two seconds earlier.
    const second = await c.cached();
    expect(second).toBe("one");
    expect(g.calls()).toBe(2);
    g.release("two");
    // And the next reader gets what that refresh produced.
    await Promise.resolve();
    expect(await c.cached()).toBe("two");
  });

  test("concurrent callers share ONE computation", async () => {
    const g = gated<number>();
    const c = swr(g.compute);
    const all = Promise.all([c.fresh(), c.fresh(), c.fresh()]);
    // A machine already short of I/O must not get three walks of the same tree
    // because three things asked at once.
    expect(g.calls()).toBe(1);
    g.release(7);
    expect(await all).toEqual([7, 7, 7]);
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
    expect(c.peek()).toBe("ok-1");
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
    expect(c.peek()).toBe("first");
  });
});
