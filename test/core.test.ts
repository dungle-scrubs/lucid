import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { DomRootLike } from "../src/anchors/dom.ts";
import { anchorResolves, captureElementAnchor, computeFingerprint } from "../src/anchors/dom.ts";
import type { ElementAnchor, RangeAnchor } from "../src/anchors/anchor.ts";
import { parseAnchor } from "../src/anchors/anchor.ts";
import { parseCursor, renderCursor } from "../src/core/cursor.ts";
import { foldLog } from "../src/core/fold.ts";
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

describe("foldLog segments", () => {
  const ev = (e: Partial<LogEvent> & { t: LogEvent["t"]; seq: number }): LogEvent =>
    ({ at: "2026-01-01T00:00:00Z", ...e }) as LogEvent;

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
