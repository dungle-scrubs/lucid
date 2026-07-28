import { describe, expect, test } from "bun:test";
import { resolveShortcut, type KeyChord, type TabState } from "../client/chrome/keymap.ts";

/**
 * The shell's keyboard map, as a table.
 *
 * These were e2e scenarios: each one cost a hub, a session, a page load and a
 * settle to ask a question the map answers on its own. Moved here per D-018 -
 * a scenario that never touches paint does not need a browser - which is what
 * makes the awkward combinations affordable enough to actually cover: a
 * modifier too many, a digit past the end of the strip, a bracket step with
 * one tab, an active tab that is not in the visible strip at all.
 *
 * What did NOT move: that the map is wired up, and that ⌘1 lands on the tab a
 * human can see. Those are claims about the shell, and they stay in e2e.
 */

const chord = (over: Partial<KeyChord> = {}): KeyChord => ({
  key: "",
  code: "",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

const tabs = (keys: string[], activeKey: string | null = keys[0] ?? null): TabState => ({
  keys,
  activeKey,
});

describe("what the map claims for itself", () => {
  test("a bare key is not ours", () => {
    // No platform modifier: someone is typing. Swallowing this would eat
    // every "w" in the composer.
    expect(resolveShortcut(chord({ key: "w", metaKey: false }), tabs(["a"]))).toEqual({
      kind: "none",
    });
  });

  test("alt disqualifies every chord", () => {
    // ⌥⌘K is a DIFFERENT gesture from ⌘K, and may belong to the OS or another
    // app. Answering it would be taking someone else's key.
    for (const key of ["k", "w", "1"]) {
      expect(resolveShortcut(chord({ key, altKey: true }), tabs(["a", "b"]))).toEqual({
        kind: "none",
      });
    }
  });

  test("control counts as the platform modifier, for the platform that uses it", () => {
    expect(
      resolveShortcut(chord({ key: "k", metaKey: false, ctrlKey: true }), tabs(["a"])),
    ).toEqual({ kind: "palette" });
  });
});

describe("the palette", () => {
  test("opens on either case of K", () => {
    for (const key of ["k", "K"]) {
      expect(resolveShortcut(chord({ key }), tabs([]))).toEqual({ kind: "palette" });
    }
  });

  test("opens with no tabs at all - it is how you get one", () => {
    expect(resolveShortcut(chord({ key: "k" }), tabs([], null))).toEqual({ kind: "palette" });
  });

  test("shift+K is not the palette", () => {
    expect(resolveShortcut(chord({ key: "K", shiftKey: true }), tabs(["a"]))).toEqual({
      kind: "none",
    });
  });
});

describe("closing", () => {
  test("closes the tab in front", () => {
    expect(resolveShortcut(chord({ key: "w" }), tabs(["a", "b"], "b"))).toEqual({
      kind: "close",
      key: "b",
    });
  });

  test("with nothing in front it is not ours to swallow", () => {
    // The pick screen is showing. A preventDefault here would eat the
    // browser's own ⌘W, which is the one a human expects to close the window.
    expect(resolveShortcut(chord({ key: "w" }), tabs(["a"], null))).toEqual({ kind: "none" });
  });
});

describe("digits index the visible strip", () => {
  const strip = tabs(["one", "two", "three"], "one");

  test("1 and 3 pick the first and third VISIBLE tabs", () => {
    expect(resolveShortcut(chord({ key: "1" }), strip)).toEqual({ kind: "activate", key: "one" });
    expect(resolveShortcut(chord({ key: "3" }), strip)).toEqual({
      kind: "activate",
      key: "three",
    });
  });

  test("a digit past the end does nothing, and swallows nothing", () => {
    // ⌘5 with three tabs. `none` rather than a clamp: jumping to the last tab
    // because you asked for one that is not there is a surprise, and eating
    // the key is worse than ignoring it.
    expect(resolveShortcut(chord({ key: "5" }), strip)).toEqual({ kind: "none" });
  });

  test("0 is not a tab index", () => {
    expect(resolveShortcut(chord({ key: "0" }), strip)).toEqual({ kind: "none" });
  });

  test("shift+digit is a different gesture", () => {
    expect(resolveShortcut(chord({ key: "1", shiftKey: true }), strip)).toEqual({ kind: "none" });
  });
});

describe("bracket stepping", () => {
  const strip = tabs(["one", "two", "three"], "two");

  test("] steps forward and [ steps back", () => {
    expect(resolveShortcut(chord({ code: "BracketRight", shiftKey: true }), strip)).toEqual({
      kind: "activate",
      key: "three",
    });
    expect(resolveShortcut(chord({ code: "BracketLeft", shiftKey: true }), strip)).toEqual({
      kind: "activate",
      key: "one",
    });
  });

  test("stepping wraps at both ends", () => {
    expect(
      resolveShortcut(
        chord({ code: "BracketRight", shiftKey: true }),
        tabs(["one", "two", "three"], "three"),
      ),
    ).toEqual({ kind: "activate", key: "one" });
    expect(
      resolveShortcut(
        chord({ code: "BracketLeft", shiftKey: true }),
        tabs(["one", "two", "three"], "one"),
      ),
    ).toEqual({ kind: "activate", key: "three" });
  });

  test("one tab has nowhere to step, so nothing happens", () => {
    expect(
      resolveShortcut(chord({ code: "BracketRight", shiftKey: true }), tabs(["only"], "only")),
    ).toEqual({ kind: "none" });
  });

  test("an active tab outside the visible strip has no position to step from", () => {
    // An INVARIANT guard, not a reachable scenario - and the distinction is
    // the point, because a test that reads as the latter while being the
    // former is how a suite fills up with assertions that cost time and prove
    // nothing.
    //
    // Today the shell cannot produce this state: `visibleTabKeys` keeps the
    // active key unconditionally, `activateTab` returns early unless the
    // handle exists, and `ensureSession` appends the key when it creates one.
    // So `indexOf(activeKey) === -1` is unreachable end to end.
    //
    // The guard stays anyway, and this pins it: the strip is project-scoped,
    // and the moment that scoping is allowed to drop the active tab - which is
    // a plausible change, not a fanciful one - stepping from -1 would activate
    // an arbitrary neighbour. Pre-extraction `Shell.tsx` had no such guard and
    // would have done exactly that, so this IS a behaviour change rather than
    // a pure extraction, and is recorded as one.
    expect(
      resolveShortcut(
        chord({ code: "BracketRight", shiftKey: true }),
        tabs(["one", "two"], "elsewhere"),
      ),
    ).toEqual({ kind: "none" });
  });

  test("brackets without shift are not stepping", () => {
    expect(resolveShortcut(chord({ code: "BracketRight" }), strip)).toEqual({ kind: "none" });
  });
});
