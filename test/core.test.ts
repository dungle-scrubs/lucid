import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { DomElementLike, DomRootLike } from "../src/anchors/dom.ts";
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
import { sanitizeAttendant, type LogEvent } from "../src/core/events.ts";
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

  test("a restructured ancestor is survived by fingerprint when the domPath went stale", () => {
    // The fingerprint layer's unique job: the element kept its place among its
    // siblings but the structure ABOVE it changed (ol became ul), so the
    // positional domPath matches nothing and only the content+structure
    // fingerprint finds it. This is also the test an off-by-one in the
    // one-pass sibling index MUST red (plan 04, M1.2): a shifted index
    // changes every hash, the fingerprint layer goes silent, and the stale
    // domPath cannot rescue it - resolution returns null.
    const original = rootOf("<body><ol><li>alpha</li><li>beta</li><li>target row</li></ol></body>");
    const target = original.querySelectorAll("li")[2] as DomElementLike;
    const anchor = captureElementAnchor(target);

    const reRender = rootOf("<body><ul><li>alpha</li><li>beta</li><li>target row</li></ul></body>");
    const resolved = resolveElementAnchor(anchor, reRender);
    expect(resolved?.textContent).toBe("target row");
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

describe("sanitizeAttendant", () => {
  test("keeps the identity fields and the model/effort a session declares", () => {
    expect(
      sanitizeAttendant({
        harness: "claude-code",
        sessionId: "sess-1",
        cwd: "/proj",
        model: "opus-4.8",
        effort: "high",
      }),
    ).toEqual({
      harness: "claude-code",
      sessionId: "sess-1",
      cwd: "/proj",
      model: "opus-4.8",
      effort: "high",
    });
  });

  test("model/effort are bounded and control-stripped like every other field", () => {
    const stamp = sanitizeAttendant({
      harness: "codex",
      model: `gpt${String.fromCharCode(0)}-5.6\n-sol`,
      effort: "u".repeat(200),
    });
    expect(stamp?.model).toBe("gpt-5.6-sol");
    expect(stamp?.effort?.length).toBe(32);
  });

  test("a stamp without them is unchanged (they are optional)", () => {
    expect(sanitizeAttendant({ harness: "pi" })).toEqual({ harness: "pi" });
    // The trace (plan 07, M1.3): well-formed rides, anything else is DROPPED
    // outright - the log-injection rule (R4), stricter than the text fields.
    expect(sanitizeAttendant({ harness: "pi", trace: "abc123def4567890" })).toEqual({
      harness: "pi",
      trace: "abc123def4567890",
    });
    expect(sanitizeAttendant({ harness: "pi", trace: "NOT-HEX" })).toEqual({ harness: "pi" });
    expect(sanitizeAttendant({ harness: "pi", model: 7, effort: null })).toEqual({ harness: "pi" });
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

  test("an ended session closes the working window", () => {
    // The defect (plan 08 finding #1): the window opened on an ack and closed
    // only on real output, so a turn that acked and then ended without
    // producing anything left the viewer saying the agent was still
    // responding - beside a header reading `approved`, for the life of the
    // session.
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", covers: 1 } as never);

    // Still working: the agent took the batch and has produced nothing yet.
    expect(foldLog([opened, ack]).agentWorking).not.toBeNull();

    // The session is over, so no turn is running.
    const ended = ev({ t: "session_ended", seq: 3 } as never);
    expect(foldLog([opened, ack, ended]).agentWorking).toBeNull();
  });

  test("two overlapping turns keep their own windows", () => {
    // Lucid permits two agents on one artifact - sessionHistory records every
    // harness that touched it, and attend guards against resuming a
    // conversation a human already has open. With ONE scalar working state,
    // turn A's output closed turn B's window and A's late ack reopened a
    // window after A had finished (plan 08, D-013).
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ackA = ev({
      t: "agent_ack",
      seq: 2,
      id: "a1",
      turnId: "A",
      at: "2026-01-01T00:00:00Z",
    } as never);
    const ackB = ev({
      t: "agent_ack",
      seq: 3,
      id: "b1",
      turnId: "B",
      at: "2026-01-01T00:05:00Z",
    } as never);

    // Both turns are working; the viewer paints the OLDEST open one.
    const both = foldLog([opened, ackA, ackB]);
    expect(both.agentWorking?.since).toBe("2026-01-01T00:00:00Z");

    // A finishes. B is still working, so the window must stay open - and it
    // must now be B's, not A's.
    const replyA = ev({ t: "agent_reply", seq: 4, id: "rA", text: "done", turnId: "A" } as never);
    const afterA = foldLog([opened, ackA, ackB, replyA]);
    expect(afterA.agentWorking).not.toBeNull();
    expect(afterA.agentWorking?.since).toBe("2026-01-01T00:05:00Z");

    // B finishes too. Now nothing is working.
    const replyB = ev({ t: "agent_reply", seq: 5, id: "rB", text: "done", turnId: "B" } as never);
    expect(foldLog([opened, ackA, ackB, replyA, replyB]).agentWorking).toBeNull();
  });

  test("agent_turn_ended closes only the turn it names", () => {
    // The terminator (plan 08 M5). A turn that reads feedback and produces
    // nothing had no way to say it stopped, so its window stayed open - the
    // viewer claiming the agent was responding, forever.
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ackA = ev({
      t: "agent_ack",
      seq: 2,
      id: "a1",
      turnId: "A",
      at: "2026-01-01T00:00:00Z",
    } as never);
    const ackB = ev({
      t: "agent_ack",
      seq: 3,
      id: "b1",
      turnId: "B",
      at: "2026-01-01T00:05:00Z",
    } as never);

    // A ends having produced nothing. B is untouched.
    const endA = ev({ t: "agent_turn_ended", seq: 4, turnId: "A", reason: "done" } as never);
    const afterA = foldLog([opened, ackA, ackB, endA]);
    expect(afterA.agentWorking).not.toBeNull();
    expect(afterA.agentWorking?.since).toBe("2026-01-01T00:05:00Z");

    // ...and it moved no delivery cursor: a turn that produced nothing has
    // answered nothing.
    expect(afterA.lastAgentOutputSeq).toBe(0);
    expect(afterA.deliveredThroughSeq).toBe(0);

    // B ends too. Nothing is working.
    const endB = ev({ t: "agent_turn_ended", seq: 5, turnId: "B", reason: "exited" } as never);
    expect(foldLog([opened, ackA, ackB, endA, endB]).agentWorking).toBeNull();

    // A terminator naming a turn nobody opened changes nothing.
    const ghost = ev({ t: "agent_turn_ended", seq: 6, turnId: "NOPE", reason: "done" } as never);
    expect(foldLog([opened, ackA, ghost]).agentWorking?.since).toBe("2026-01-01T00:00:00Z");
  });

  test("a terminator wakes no blocked waiter, and a second one is a no-op", () => {
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", turnId: "A" } as never);
    const end = ev({ t: "agent_turn_ended", seq: 3, turnId: "A", reason: "done" } as never);

    // The whole reason M3 made the wake set explicit: agent B blocked at a
    // cursor must not return `waiting` because agent A's turn ended.
    expect(foldLog([opened, ack, end]).lastNonAckSeq).toBe(1);

    // Ending an already-ended turn changes nothing.
    const again = ev({ t: "agent_turn_ended", seq: 4, turnId: "A", reason: "failed" } as never);
    const twice = foldLog([opened, ack, end, again]);
    expect(twice.agentWorking).toBeNull();
    expect(twice.lastNonAckSeq).toBe(1);
  });

  test("a late ack cannot reopen a turn that already finished", () => {
    // An agent that finished and then flushed a queued progress line would
    // otherwise look alive again - forever, since nothing else closes it.
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", turnId: "A" } as never);
    const reply = ev({ t: "agent_reply", seq: 3, id: "r1", text: "done", turnId: "A" } as never);
    const lateAck = ev({
      t: "agent_ack",
      seq: 4,
      id: "a2",
      turnId: "A",
      progress: { label: "still auditing" },
    } as never);

    expect(foldLog([opened, ack, reply, lateAck]).agentWorking).toBeNull();
  });

  test("an ack with no turnId is the anonymous turn, exactly as before", () => {
    // The additive claim: every log written before turn identity folds the way
    // it always did. Untagged output closes the untagged turn.
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1" } as never);
    expect(foldLog([opened, ack]).agentWorking).not.toBeNull();

    const reply = ev({ t: "agent_reply", seq: 3, id: "r1", text: "done" } as never);
    expect(foldLog([opened, ack, reply]).agentWorking).toBeNull();
  });

  test("a turn id from a previous segment means nothing in this one", () => {
    // Turn ids are segment-scoped. A reopen folds from its own
    // session_opened, so an id reused across the boundary cannot close - or
    // resurrect - anything in the new segment.
    const s1 = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ackS1 = ev({ t: "agent_ack", seq: 2, id: "a1", turnId: "A" } as never);
    const ended = ev({ t: "session_ended", seq: 3 } as never);
    const s2 = ev({
      t: "session_opened",
      seq: 4,
      segment: 2,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s2/v1.html",
    } as never);
    // Same id, new segment: it opens a NEW turn rather than reopening the old.
    const ackS2 = ev({ t: "agent_ack", seq: 5, id: "a2", turnId: "A" } as never);

    const state = foldLog([s1, ackS1, ended, s2, ackS2]);
    expect(state.agentWorking).not.toBeNull();
    expect(state.segment).toBe(2);
  });

  test("only wake-relevant events advance the seq `wait` blocks on", () => {
    // `wait` blocks past ack-only deltas by comparing its cursor to
    // lastNonAckSeq. That used to mean "every event that is not an agent_ack",
    // which silently enrolls every event type added afterwards - so presence
    // traffic would wake every blocked agent the day it shipped. The set is
    // explicit now; this pins both directions (plan 08 M3, D-019).
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);

    // An ack is an agent talking about itself, not feedback for anyone.
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", covers: 1 } as never);
    expect(foldLog([opened, ack]).lastNonAckSeq).toBe(1);

    // Real feedback and real output both wake a waiter, as they always have.
    const annotation = ev({
      t: "annotation",
      seq: 3,
      id: "n1",
      version: 1,
      target: { kind: "element", fingerprint: "f", domPath: "li", snippet: "<li>x</li>" },
      note: "look here",
    } as never);
    expect(foldLog([opened, ack, annotation]).lastNonAckSeq).toBe(3);

    const reply = ev({ t: "agent_reply", seq: 4, id: "r1", text: "done" } as never);
    expect(foldLog([opened, ack, annotation, reply]).lastNonAckSeq).toBe(4);

    // ...and a second ack after them still moves nothing.
    const ack2 = ev({ t: "agent_ack", seq: 5, id: "a2", covers: 3 } as never);
    expect(foldLog([opened, ack, annotation, reply, ack2]).lastNonAckSeq).toBe(4);
  });

  test("suspension and approval are NOT evidence a turn ended", () => {
    // The guard on the rule above. Suspension fires on "no subscribers and
    // status active" - a human closing the viewer while an agent legitimately
    // works - and a resume stays in the SAME segment, so treating either as a
    // closer would erase a live turn permanently. Approval describes the
    // review, not the agent: a turn may still be writing when a human
    // approves.
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", covers: 1 } as never);

    const suspended = ev({ t: "session_suspended", seq: 3 } as never);
    expect(foldLog([opened, ack, suspended]).agentWorking).not.toBeNull();

    const resumed = ev({ t: "session_resumed", seq: 4, segment: 1 } as never);
    expect(foldLog([opened, ack, suspended, resumed]).agentWorking).not.toBeNull();

    const approved = ev({ t: "review_resolved", seq: 5 } as never);
    expect(foldLog([opened, ack, approved]).agentWorking).not.toBeNull();
  });

  test("a reopened session folds from its own segment, with no stale window", () => {
    // `session_ended` closing the window is belt; segmentation is braces. A
    // reopen starts a fresh segment, so the previous segment's dangling ack is
    // not even seen - which is why the rule above is needed for the
    // ended-and-NOT-reopened log specifically.
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", covers: 1 } as never);
    const ended = ev({ t: "session_ended", seq: 3 } as never);
    const reopened = ev({
      t: "session_opened",
      seq: 4,
      segment: 2,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s2/v1.html",
    } as never);

    expect(foldLog([opened, ack, ended, reopened]).agentWorking).toBeNull();
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

describe("validateStructure honors the parser's hiding rules (plan 04, #44)", () => {
  test("literal closing tags inside a textarea are text, not structure", () => {
    const html = `<!doctype html><html><head><title>t</title></head><body>
<textarea>Paste </body> and </html> at the end.</textarea>
</body></html>`;
    expect(validateStructure(html).ok).toBe(true);
  });

  test("a commented-out </html> does not balance a real missing one", () => {
    const html = `<!doctype html><html><head><title>t</title></head><body>
<!-- </html> -->
</body>`;
    const r = validateStructure(html);
    expect(r.ok).toBe(false); // the REAL closing root is still missing
  });
});

describe("close tags with internal whitespace (plan 04, F9)", () => {
  test("a legal `</body\\n>` close satisfies the structural guard", () => {
    expect(validateStructure("<html><body><p>a</p></body\n></html>").ok).toBe(true);
  });
});

describe("an unowned turn", () => {
  const ev = (e: Partial<LogEvent> & { t: LogEvent["t"]; seq: number }): LogEvent =>
    ({ at: "2026-01-01T00:00:00Z", ...e }) as LogEvent;

  test("an interactive turn is anonymous, and nothing terminates it", () => {
    // The documented gap (CONTEXT.md, D-024). A turn a human drives in their
    // own terminal has no LUCID_TURN_ID, so its acks are anonymous and the hub
    // - which never spawned it - appends no terminator. The viewer's
    // ten-minute stale state is the answer, exactly as it is for an agent that
    // was killed. Asserted so the gap is a decision with a test behind it
    // rather than something a reader has to infer.
    const opened = ev({
      t: "session_opened",
      seq: 1,
      segment: 1,
      artifact: "a.html",
      version: 1,
      hash: "h",
      path: "versions/s1/v1.html",
    } as never);
    const anonAck = ev({ t: "agent_ack", seq: 2, id: "a1" } as never);

    // Open, and it stays open: no output, no terminator naming it.
    expect(foldLog([opened, anonAck]).agentWorking).not.toBeNull();

    // A terminator for a NAMED turn does not close the anonymous one.
    const other = ev({ t: "agent_turn_ended", seq: 3, turnId: "T1", reason: "done" } as never);
    expect(foldLog([opened, anonAck, other]).agentWorking).not.toBeNull();

    // Its own output does close it - the ordinary path an interactive turn takes.
    const reply = ev({ t: "agent_reply", seq: 4, id: "r1", text: "done" } as never);
    expect(foldLog([opened, anonAck, other, reply]).agentWorking).toBeNull();
  });
});

describe("a turn that ended with nothing to show", () => {
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

  test("the outcome survives the window closing", () => {
    // Closing the window is right - the agent is not working. But closing it
    // SILENTLY loses the outcome: a turn that read the feedback and correctly
    // decided nothing was needed looked identical to one that never happened,
    // leaving the human with feedback marked delivered and no idea what came
    // of it (OQ-3).
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", turnId: "T1", covers: 1 } as never);
    const end = ev({
      t: "agent_turn_ended",
      seq: 3,
      turnId: "T1",
      reason: "done",
      at: "2026-01-01T00:09:00Z",
    } as never);

    const state = foldLog([opened, ack, end]);
    expect(state.agentWorking).toBeNull();
    expect(state.lastTurnEnd).toEqual({ reason: "done", at: "2026-01-01T00:09:00Z" });
  });

  test("real output clears it - the output IS the answer", () => {
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", turnId: "T1" } as never);
    const end = ev({ t: "agent_turn_ended", seq: 3, turnId: "T1", reason: "done" } as never);
    const reply = ev({ t: "agent_reply", seq: 4, id: "r1", text: "here you go" } as never);

    expect(foldLog([opened, ack, end, reply]).lastTurnEnd).toBeNull();
  });

  test("a failed turn is distinguishable from one that simply had nothing to add", () => {
    const ack = ev({ t: "agent_ack", seq: 2, id: "a1", turnId: "T1" } as never);
    const failed = ev({
      t: "agent_turn_ended",
      seq: 3,
      turnId: "T1",
      reason: "usage_limit",
      code: "session_wall",
    } as never);

    const state = foldLog([opened, ack, failed]);
    expect(state.lastTurnEnd?.reason).toBe("usage_limit");
    expect(state.lastTurnEnd?.code).toBe("session_wall");
  });
});
