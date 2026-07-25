import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { DomRootLike } from "../src/anchors/dom.ts";
import {
  anchorResolves,
  captureElementAnchor,
  computeFingerprint,
  resolveElementAnchor,
} from "../src/anchors/dom.ts";
import type { ElementAnchor, RangeAnchor } from "../src/anchors/anchor.ts";
import { parseAnchor } from "../src/anchors/anchor.ts";
import { parseCursor, renderCursor } from "../src/core/cursor.ts";
import { foldLog } from "../src/core/fold.ts";
import { sanitizeProgress } from "../src/core/progress.ts";
import { sanitizeContext } from "../src/core/context.ts";
import type { LogEvent } from "../src/core/events.ts";
import { hashContent, validateStructure } from "../src/core/version.ts";

const rootOf = (html: string): DomRootLike => parseHTML(html).document as unknown as DomRootLike;

describe("cursor", () => {
  test("round-trips seq", () => {
    expect(renderCursor(42)).toBe("evt_00042");
    expect(parseCursor("evt_00042")).toBe(42);
    expect(parseCursor("42")).toBe(42);
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor("")).toBeUndefined();
    expect(parseCursor("garbage")).toBeUndefined();
  });
});

describe("validateStructure", () => {
  test("accepts a complete document", () => {
    const r = validateStructure("<html><body><p>hi</p></body></html>");
    expect(r.ok).toBe(true);
  });
  test("accepts a complete fragment", () => {
    expect(validateStructure("<ul><li>a</li><li>b</li></ul>").ok).toBe(true);
  });
  test("rejects mid-tag truncation", () => {
    const r = validateStructure("<html><body><li>Backfill from the even");
    expect(r.ok).toBe(false);
  });
  test("rejects missing </body>", () => {
    const r = validateStructure("<html><body><p>hi</p></html>");
    expect(r.ok).toBe(false);
  });
  test("rejects unbalanced container", () => {
    const r = validateStructure("<body><ul><li>a</li></body>");
    expect(r.ok).toBe(false);
  });
  test("rejects empty", () => {
    expect(validateStructure("   ").ok).toBe(false);
  });
});

describe("hashContent", () => {
  test("is stable and prefixed", () => {
    const h = hashContent("hello");
    expect(h.startsWith("sha256:")).toBe(true);
    expect(hashContent("hello")).toBe(h);
    expect(hashContent("world")).not.toBe(h);
  });
});

describe("anchors/dom", () => {
  test("fingerprint is deterministic across equal DOMs", () => {
    const a = rootOf("<body><ul><li>Backfill from the events table</li></ul></body>");
    const b = rootOf("<body><ul><li>Backfill from the events table</li></ul></body>");
    const elA = a.querySelector("li");
    const elB = b.querySelector("li");
    expect(elA && elB).toBeTruthy();
    expect(computeFingerprint(elA!)).toBe(computeFingerprint(elB!));
  });

  test("captures and resolves an element anchor via fingerprint", () => {
    const root = rootOf("<body><article><ol><li>one</li><li>two</li></ol></article></body>");
    const li = root.querySelectorAll("li")[1];
    expect(li).toBeTruthy();
    const anchor = captureElementAnchor(li!);
    expect(anchor.kind).toBe("element");
    // Re-render with same content resolves.
    const reRender = rootOf("<body><article><ol><li>one</li><li>two</li></ol></article></body>");
    expect(anchorResolves(anchor, reRender)).toBe(true);
    // Content removed -> does not resolve.
    const changed = rootOf("<body><article><ol><li>one</li></ol></article></body>");
    expect(anchorResolves(anchor, changed)).toBe(false);
  });

  test("resolves lucidId only when unique", () => {
    const anchor: ElementAnchor = {
      kind: "element",
      lucidId: "step-1",
      fingerprint: 'nope#0000·"x"',
      domPath: "section:nth-child(9)",
      snippet: "<div>x</div>",
    };
    const unique = rootOf('<body><div data-lucid-id="step-1">x</div></body>');
    expect(anchorResolves(anchor, unique)).toBe(true);
    const dup = rootOf(
      '<body><div data-lucid-id="step-1">x</div><div data-lucid-id="step-1">y</div></body>',
    );
    // non-unique lucidId is skipped, fingerprint won't match -> false
    expect(anchorResolves(anchor, dup)).toBe(false);
  });

  test("identical-text siblings get distinct fingerprints and resolve to the right one", () => {
    const root = rootOf("<body><ul><li>same</li><li>same</li><li>same</li></ul></body>");
    const lis = root.querySelectorAll("li");
    const first = lis[0]!;
    const third = lis[2]!;
    // Identical text but distinct fingerprints (sibling index folded into hash).
    expect(computeFingerprint(first)).not.toBe(computeFingerprint(third));
    // An anchor captured on the third <li> resolves on an identical re-render.
    const anchor = captureElementAnchor(third);
    const reRender = rootOf("<body><ul><li>same</li><li>same</li><li>same</li></ul></body>");
    expect(anchorResolves(anchor, reRender)).toBe(true);
  });

  test("identical cells across table rows resolve to the clicked one, not the first", () => {
    // Each "Not audited" cell sits at the same column position in its own row,
    // so they share a fingerprint. The ambiguous fingerprint must fall through
    // to the positional domPath instead of collapsing onto the first cell.
    const html =
      "<body><table><tbody>" +
      "<tr><td>Onboarding</td><td>Not audited</td></tr>" +
      "<tr><td>Dashboard</td><td>Not audited</td></tr>" +
      "<tr><td>Alerts</td><td>Not audited</td></tr>" +
      "</tbody></table></body>";
    const root = rootOf(html);
    const cells = Array.from(root.querySelectorAll("td")).filter(
      (c) => (c.textContent ?? "").trim() === "Not audited",
    );
    expect(cells.length).toBe(3);
    // The three cells share a fingerprint (same tag, column position, text).
    expect(computeFingerprint(cells[0]!)).toBe(computeFingerprint(cells[2]!));
    // Capturing each and resolving against an identical re-render lands on the
    // matching row - not on cells[0] every time.
    const reRender = rootOf(html);
    const rows = Array.from(reRender.querySelectorAll("td")).filter(
      (c) => (c.textContent ?? "").trim() === "Not audited",
    );
    cells.forEach((cell, i) => {
      const anchor = captureElementAnchor(cell);
      const resolved = resolveElementAnchor(anchor, reRender);
      expect(resolved).toBe(rows[i]!);
    });
  });

  test("resolves a range anchor by quote", () => {
    const anchor: RangeAnchor = {
      kind: "range",
      quote: { exact: "events table", prefix: "Backfill from the ", suffix: " nightly" },
      position: { start: 0, end: 0 },
      snippet: "events table",
    };
    const root = rootOf("<body><p>Backfill from the events table nightly please</p></body>");
    expect(anchorResolves(anchor, root)).toBe(true);
    const noMatch = rootOf("<body><p>nothing here</p></body>");
    expect(anchorResolves(anchor, noMatch)).toBe(false);
  });
});

describe("parseAnchor", () => {
  test("accepts valid element anchor", () => {
    const r = parseAnchor({
      kind: "element",
      fingerprint: "f",
      domPath: "p",
      snippet: "<p>x</p>",
    });
    expect("error" in r).toBe(false);
  });
  test("rejects malformed anchor", () => {
    expect("error" in parseAnchor({ kind: "element" })).toBe(true);
    expect("error" in parseAnchor(null)).toBe(true);
    expect("error" in parseAnchor({ kind: "bogus" })).toBe(true);
  });
});

describe("sanitizeProgress", () => {
  test("keeps a clean report and floors counts", () => {
    expect(sanitizeProgress({ label: "auditing", total: 7, done: 3.9 })).toEqual({
      label: "auditing",
      total: 7,
      done: 3,
    });
  });
  test("drops negative, non-finite, and non-numeric counts", () => {
    // Guards the no-daemon direct-append path, which never hits the server.
    expect(sanitizeProgress({ total: -4, done: Number.NaN })).toBeUndefined();
    expect(sanitizeProgress({ label: "x", total: -1, done: "3" })).toEqual({ label: "x" });
  });
  test("returns undefined when nothing usable survives", () => {
    expect(sanitizeProgress({ label: "" })).toBeUndefined();
    expect(sanitizeProgress(null)).toBeUndefined();
    expect(sanitizeProgress("nope")).toBeUndefined();
  });
});

describe("sanitizeContext", () => {
  test("takes an explicit pct, clamped to 0..100", () => {
    expect(sanitizeContext({ pct: 71 })).toEqual({ pct: 71 });
    expect(sanitizeContext({ pct: 140 })).toEqual({ pct: 100 });
    expect(sanitizeContext({ pct: -5 })).toEqual({ pct: 0 });
  });
  test("derives pct from used/total and keeps them for the tooltip", () => {
    expect(sanitizeContext({ used: 142000, total: 200000 })).toEqual({
      pct: 71,
      used: 142000,
      total: 200000,
    });
  });
  test("prefers an explicit pct over the derived one", () => {
    expect(sanitizeContext({ pct: 50, used: 142000, total: 200000 })).toEqual({
      pct: 50,
      used: 142000,
      total: 200000,
    });
  });
  test("returns undefined when no fill fraction can be established", () => {
    expect(sanitizeContext({ used: 142000 })).toBeUndefined(); // total missing
    expect(sanitizeContext({ used: -1, total: 200000 })).toBeUndefined();
    expect(sanitizeContext({})).toBeUndefined();
    expect(sanitizeContext({ pct: Number.NaN })).toBeUndefined();
  });
});

describe("foldLog segments", () => {
  const ev = (e: Partial<LogEvent> & { t: LogEvent["t"]; seq: number }): LogEvent =>
    ({ at: "2026-01-01T00:00:00Z", ...e }) as LogEvent;

  test("derives session history from attendant stamps, whole-log (D18)", () => {
    const events: LogEvent[] = [
      ev({
        t: "session_opened",
        seq: 1,
        segment: 1,
        artifact: "a.html",
        version: 1,
        hash: "h",
        path: "versions/s1/v1.html",
        attendant: { harness: "claude_code", sessionId: "sess-1", cwd: "/proj" },
      } as never),
      ev({
        t: "agent_reply",
        seq: 2,
        at: "2026-01-01T01:00:00Z",
        id: "r1",
        text: "hello",
        attendant: { harness: "claude_code", sessionId: "sess-1", cwd: "/proj" },
      } as never),
      // A different session takes over later - and an unstamped human event
      // in between contributes nothing to the history.
      ev({
        t: "prompt",
        seq: 3,
        id: "p1",
        refs: [],
        text: "human words",
      } as never),
      ev({
        t: "agent_ack",
        seq: 4,
        at: "2026-01-01T02:00:00Z",
        id: "a1",
        attendant: { harness: "codex", sessionId: "sess-2" },
      } as never),
    ];
    const s = foldLog(events);
    expect(s.sessionHistory).toHaveLength(2);
    const [born, second] = s.sessionHistory;
    expect(born?.harness).toBe("claude_code");
    expect(born?.sessionId).toBe("sess-1");
    expect(born?.cwd).toBe("/proj");
    expect(born?.events).toBe(2);
    expect(born?.firstAt).toBe("2026-01-01T00:00:00Z");
    expect(born?.lastAt).toBe("2026-01-01T01:00:00Z");
    expect(second?.harness).toBe("codex");
    expect(second?.events).toBe(1);
    // Old logs without stamps fold to an empty history, not a failure.
    expect(foldLog([events[2] as LogEvent]).sessionHistory).toEqual([]);
  });

  test("folds a single segment", () => {
    const events: LogEvent[] = [
      ev({
        t: "session_opened",
        seq: 1,
        segment: 1,
        artifact: "a.html",
        version: 1,
        hash: "h",
        path: "versions/s1/v1.html",
      } as Partial<LogEvent> & { t: "session_opened"; seq: number }),
      ev({
        t: "version",
        seq: 2,
        version: 2,
        hash: "h2",
        path: "versions/s1/v2.html",
      } as Partial<LogEvent> & { t: "version"; seq: number }),
      ev({
        t: "annotation",
        seq: 3,
        id: "x",
        version: 2,
        target: { kind: "element", fingerprint: "f", domPath: "p", snippet: "s" },
        note: "n",
      } as Partial<LogEvent> & { t: "annotation"; seq: number }),
    ];
    const s = foldLog(events);
    expect(s.status).toBe("active");
    expect(s.version).toBe(2);
    expect(s.annotations.length).toBe(1);
    expect(s.highSeq).toBe(3);
  });

  test("carries an annotation's targets and an answer's anchors, first-element rule intact", () => {
    const spot = (n: number) => ({
      kind: "element" as const,
      fingerprint: `f${n}`,
      domPath: `p:nth-child(${n})`,
      snippet: `<p>${n}</p>`,
    });
    const events: LogEvent[] = [
      ev({
        t: "session_opened",
        seq: 1,
        segment: 1,
        artifact: "a.html",
        version: 1,
        hash: "h",
        path: "versions/s1/v1.html",
      } as never),
      ev({
        t: "annotation",
        seq: 2,
        id: "a1",
        version: 1,
        target: spot(1),
        targets: [spot(1), spot(2)],
        note: "both of these",
      } as never),
      ev({ t: "question", seq: 3, id: "q1", text: "where?" } as never),
      ev({
        t: "question_answered",
        seq: 4,
        id: "ans1",
        questionId: "q1",
        text: "here and here",
        anchor: spot(1),
        anchors: [spot(1), spot(3)],
      } as never),
    ];
    const s = foldLog(events);
    expect(s.annotations[0]?.targets).toEqual([spot(1), spot(2)]);
    expect(s.annotations[0]?.target).toEqual(spot(1)); // legacy readers see the first
    expect(s.questions[0]?.answerAnchors).toEqual([spot(1), spot(3)]);
    expect(s.questions[0]?.answerAnchor).toEqual(spot(1));
  });

  test("agent_ack progress accumulates last-writer-wins and closes on output", () => {
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    // Fan-out start, then a bump as a subagent reports.
    const start = ev({
      t: "agent_ack",
      seq: 2,
      id: "a1",
      progress: { label: "auditing 7 screens", total: 7, done: 0 },
    } as never);
    // A later bump carries ONLY --done; total + label must survive the merge.
    const bump = ev({
      t: "agent_ack",
      seq: 3,
      id: "a2",
      progress: { done: 3 },
    } as never);

    const open = foldLog([opened, start, bump]);
    expect(open.agentWorking?.progress).toEqual({
      label: "auditing 7 screens",
      total: 7,
      done: 3,
    });
    // The first ack's time is the window's `since`; a re-ack does not restart it.
    expect(open.agentWorking?.since).toBe("2026-01-01T00:00:00Z");

    // Any real output closes the window and clears progress.
    const version = ev({
      t: "version",
      seq: 4,
      version: 2,
      hash: "h2",
      path: "versions/s1/v2.html",
    } as never);
    expect(foldLog([opened, start, bump, version]).agentWorking).toBeNull();
  });

  test("folds fork requests separately from annotations", () => {
    const events: LogEvent[] = [
      ev({
        t: "session_opened",
        seq: 1,
        segment: 1,
        artifact: "a.html",
        version: 1,
        hash: "h",
        path: "versions/s1/v1.html",
      } as never),
      ev({
        t: "fork",
        seq: 2,
        id: "fk",
        version: 1,
        target: { kind: "element", fingerprint: "f", domPath: "p", snippet: "s" },
        note: "spin off a plan",
      } as never),
    ];
    const s = foldLog(events);
    expect(s.annotations.length).toBe(0);
    expect(s.forks.length).toBe(1);
    expect(s.forks[0]?.note).toBe("spin off a plan");
  });

  test("re-segment scopes annotations to the latest segment (D-056)", () => {
    const events: LogEvent[] = [
      ev({
        t: "session_opened",
        seq: 1,
        segment: 1,
        artifact: "a.html",
        version: 1,
        hash: "h",
        path: "versions/s1/v1.html",
      } as never),
      ev({
        t: "annotation",
        seq: 2,
        id: "old",
        version: 1,
        target: { kind: "element", fingerprint: "f", domPath: "p", snippet: "s" },
        note: "old",
      } as never),
      ev({ t: "session_ended", seq: 3 } as never),
      ev({
        t: "session_opened",
        seq: 4,
        segment: 2,
        artifact: "a.html",
        version: 1,
        hash: "h2",
        path: "versions/s2/v1.html",
      } as never),
      ev({
        t: "annotation",
        seq: 5,
        id: "new",
        version: 1,
        target: { kind: "element", fingerprint: "f2", domPath: "p", snippet: "s" },
        note: "new",
      } as never),
    ];
    const s = foldLog(events);
    expect(s.status).toBe("active");
    expect(s.segment).toBe(2);
    expect(s.annotations.map((a) => a.id)).toEqual(["new"]);
    expect(s.highSeq).toBe(5);
  });

  test("review_resolved then review_reopened clears (D-059)", () => {
    const events: LogEvent[] = [
      ev({
        t: "session_opened",
        seq: 1,
        segment: 1,
        artifact: "a.html",
        version: 1,
        hash: "h",
        path: "p",
      } as never),
      ev({ t: "review_resolved", seq: 2 } as never),
      ev({ t: "review_reopened", seq: 3 } as never),
    ];
    expect(foldLog(events).reviewResolved).toBe(false);
    expect(foldLog(events.slice(0, 2)).reviewResolved).toBe(true);
  });
});
