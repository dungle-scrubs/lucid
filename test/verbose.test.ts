import { describe, expect, test } from "bun:test";
import { isVerbose, tracer, verboseSubsystems } from "../src/core/verbose.ts";
import { resolveElementMatch } from "../src/anchors/dom.ts";
import { attendDecision, attendReason } from "../src/server/attend.ts";

/**
 * The scoped verbose toggle (plan 07, M3.1 - technique 4). The DEFAULT is the
 * technique: internal narration is silent until a subsystem is named, and the
 * flag governs internal tracing only - it must never gate the always-on
 * boundary records from Phase 1.
 */

describe("verboseSubsystems: what the flag names", () => {
  test("unset or empty names nothing", () => {
    expect(verboseSubsystems({})).toEqual([]);
    expect(verboseSubsystems({ LUCID_VERBOSE: "" })).toEqual([]);
    expect(verboseSubsystems({ LUCID_VERBOSE: "   " })).toEqual([]);
  });

  test("a comma-separated list, trimmed and lowercased", () => {
    expect(verboseSubsystems({ LUCID_VERBOSE: "anchors" })).toEqual(["anchors"]);
    expect(verboseSubsystems({ LUCID_VERBOSE: " Anchors , ATTEND " })).toEqual([
      "anchors",
      "attend",
    ]);
  });

  test("an unknown subsystem is dropped, not guessed at", () => {
    expect(verboseSubsystems({ LUCID_VERBOSE: "anchors,nonsense" })).toEqual(["anchors"]);
  });

  test("`all` names every subsystem - one spelling for 'be loud everywhere'", () => {
    expect(verboseSubsystems({ LUCID_VERBOSE: "all" }).sort()).toEqual(["anchors", "attend"]);
  });
});

describe("isVerbose: scoped, so one subsystem's noise is not another's", () => {
  test("naming anchors does not make attend loud", () => {
    const env = { LUCID_VERBOSE: "anchors" };
    expect(isVerbose("anchors", env)).toBe(true);
    expect(isVerbose("attend", env)).toBe(false);
  });

  test("with the flag unset, nothing is verbose - the default IS the technique", () => {
    expect(isVerbose("anchors", {})).toBe(false);
    expect(isVerbose("attend", {})).toBe(false);
  });
});

describe("tracer: a no-op when off, so call sites need no guard of their own", () => {
  test("an off tracer never calls its sink, and never even builds the message", () => {
    const lines: string[] = [];
    let built = 0;
    const trace = tracer("anchors", { env: {}, sink: (l) => void lines.push(l) });
    trace(() => {
      built += 1;
      return "expensive to describe";
    });
    expect(lines).toEqual([]);
    // The message is a THUNK: narration that costs something to produce must
    // not be produced when nobody asked for it.
    expect(built).toBe(0);
  });

  test("an on tracer emits, prefixed with its subsystem", () => {
    const lines: string[] = [];
    const trace = tracer("anchors", {
      env: { LUCID_VERBOSE: "anchors" },
      sink: (l) => void lines.push(l),
    });
    trace(() => "matched by lucidId");
    expect(lines).toEqual(["[anchors] matched by lucidId"]);
  });
});

describe("the anchors subsystem narrates which layer matched, and why the others did not", () => {
  const html = `<html><body>
    <p data-lucid-id="p1">first</p>
    <p>second</p>
    <div class="row">a</div><div class="row">b</div>
  </body></html>`;

  const resolveWith = async (
    anchor: Parameters<typeof resolveElementMatch>[0],
    env: Record<string, string>,
  ): Promise<string[]> => {
    const lines: string[] = [];
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(html);
    resolveElementMatch(anchor, document as never, {
      trace: tracer("anchors", { env, sink: (l) => void lines.push(l) }),
    });
    return lines;
  };

  test("with the flag UNSET it says nothing at all", async () => {
    const lines = await resolveWith({ type: "element", lucidId: "p1" } as never, {});
    expect(lines).toEqual([]);
  });

  test("a lucidId hit names the layer that won", async () => {
    const lines = await resolveWith({ type: "element", lucidId: "p1" } as never, {
      LUCID_VERBOSE: "anchors",
    });
    expect(lines.join("\n")).toContain("lucidId");
    expect(lines.join("\n")).toMatch(/exact/);
  });

  test("a MISSING lucidId says why that layer was skipped, then names the one that answered", async () => {
    const lines = await resolveWith(
      { type: "element", lucidId: "gone", domPath: "body > p:nth-of-type(2)" } as never,
      { LUCID_VERBOSE: "anchors" },
    );
    const all = lines.join("\n");
    // The question the human actually has: why did it pick THAT element?
    expect(all).toContain("lucidId");
    expect(all).toMatch(/0 match|no match/i);
    expect(all).toContain("domPath");
    expect(all).toMatch(/positional/i);
  });

  test("a NON-UNIQUE fingerprint reports the ambiguity that made it fall through", async () => {
    const lines = await resolveWith(
      { type: "element", fingerprint: "div|row|1", domPath: "body > div:nth-of-type(2)" } as never,
      { LUCID_VERBOSE: "anchors" },
    );
    expect(lines.join("\n")).toContain("fingerprint");
  });
});

describe("the attend subsystem says WHICH precondition stopped a turn", () => {
  const base = {
    pendingFeedbackSeqs: [1],
    inFlight: false,
    listening: 0,
    now: 10_000,
    firstPendingAt: 0,
    debounceMs: 100,
    workingGraceMs: 60_000,
    workingSince: undefined,
  };

  test("every non-spawn verdict names the reason that produced it", () => {
    expect(attendReason({ ...base, pendingFeedbackSeqs: [] }).reason).toMatch(/nothing pending/i);
    expect(attendReason({ ...base, inFlight: true }).reason).toMatch(/in flight|already/i);
    expect(attendReason({ ...base, listening: 1 }).reason).toMatch(/listening/i);
    expect(attendReason({ ...base, workingSince: 9_990 }).reason).toMatch(/working|mid-turn/i);
    expect(attendReason({ ...base, firstPendingAt: 9_950 }).reason).toMatch(/debounce|quiet/i);
  });

  test("the reason agrees with the decision, always - one source of truth", () => {
    const cases = [
      { ...base, pendingFeedbackSeqs: [] },
      { ...base, inFlight: true },
      { ...base, listening: 2 },
      { ...base, workingSince: 9_990 },
      { ...base, firstPendingAt: 9_950 },
      { ...base },
    ];
    for (const input of cases) {
      expect(attendReason(input).decision).toBe(attendDecision(input));
    }
  });

  test("a spawn says so too - the loud path is not only about refusals", () => {
    expect(attendReason(base).decision).toBe("spawn");
    expect(attendReason(base).reason).toMatch(/spawn|deliver/i);
  });
});
