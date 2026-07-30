import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isVerbose,
  resetUnknownWarning,
  setNarrationSink,
  tracer,
  warnUnknownSubsystems,
  unknownSubsystems,
  verboseSubsystems,
} from "../src/core/verbose.ts";

import { computeFingerprint, resolveElementMatch } from "../src/anchors/dom.ts";
import { attendReason } from "../src/server/attend.ts";

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
    // A REAL collision, of the shape the resolver's own comment names:
    // identical status cells sharing a column position across table rows. Same
    // tag, same text, same index within their own parent - so the fingerprints
    // are equal and the layer must fall through. A made-up string produces 0
    // matches and reports "no match", a different branch than the one named.
    const { parseHTML } = await import("linkedom");
    const table = `<html><body><table>
      <tr><td>ok</td></tr>
      <tr><td>ok</td></tr>
    </table></body></html>`;
    const { document } = parseHTML(table);
    const cells = Array.from(document.querySelectorAll("td"));
    const fp = computeFingerprint(cells[0] as never);
    expect(computeFingerprint(cells[1] as never)).toBe(fp);

    const lines: string[] = [];
    const { document: doc2 } = parseHTML(table);
    resolveElementMatch(
      { type: "element", fingerprint: fp, domPath: "tr:nth-of-type(2) td" } as never,
      doc2 as never,
      {
        trace: tracer("anchors", {
          env: { LUCID_VERBOSE: "anchors" },
          sink: (l) => void lines.push(l),
        }),
      },
    );
    const all = lines.join("\n");
    expect(all).toContain("ambiguous");
    expect(all).toMatch(/2 matches/);
  });

  test("a trace NEVER prints the fingerprint's text preview - that is review content", async () => {
    const secret = "SENTINEL_REVIEW_TEXT_do_not_log";
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(`<html><body><p>${secret}</p></body></html>`);
    const el = document.querySelector("p");
    const fp = computeFingerprint(el as never, 1);
    // The fingerprint itself carries the preview - that is its design.
    expect(fp).toContain(secret.slice(0, 10));

    const lines: string[] = [];
    resolveElementMatch({ type: "element", fingerprint: `${fp}x` } as never, document as never, {
      trace: tracer("anchors", {
        env: { LUCID_VERBOSE: "anchors" },
        sink: (l) => void lines.push(l),
      }),
    });
    // The TRACE must not, because it lands in an uncapped log at poll rate.
    expect(lines.join("\n")).not.toContain(secret.slice(0, 10));
    // ...while still naming the fingerprint by its hash, which is what a
    // human comparing a mismatch actually needs.
    expect(lines.join("\n")).toMatch(/fingerprint p#[a-z0-9]+/);
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

  test("a spawn says so too - the loud path is not only about refusals", () => {
    expect(attendReason(base).decision).toBe("spawn");
    expect(attendReason(base).reason).toMatch(/spawn|deliver/i);
  });
});

describe("narration goes where THIS process's evidence goes (M3.1)", () => {
  test("setNarrationSink redirects EVERY subsystem's default - not one wired by hand", () => {
    // The hub is normally started detached with stdio "ignore", so a stderr
    // default is /dev/null there: narration written to it is not quiet, it is
    // LOST, which is worse than off because the flag looks like it worked.
    // One process-wide sink, so no subsystem can be forgotten - `anchors` was,
    // when only `attend` had been wired by hand.
    const prev = process.env.LUCID_VERBOSE;
    process.env.LUCID_VERBOSE = "all";
    const lines: string[] = [];
    let restore = (): void => {};
    try {
      restore = setNarrationSink((l) => void lines.push(l));
      tracer("attend")(() => "plan: wait - 1 agent(s) listening");
      tracer("anchors")(() => "fingerprint p#ab12 -> 1 match, exact");
      expect(lines).toEqual([
        "[attend] plan: wait - 1 agent(s) listening",
        "[anchors] fingerprint p#ab12 -> 1 match, exact",
      ]);
    } finally {
      restore();
      if (prev === undefined) delete process.env.LUCID_VERBOSE;
      else process.env.LUCID_VERBOSE = prev;
    }
  });

  test("the hub installs it, so a hub-hosted session's narration is not discarded", () => {
    // Asserted on the source: the wiring is one line and its absence is
    // invisible at runtime until somebody sets the flag on a real hub.
    const src = readFileSync(join(import.meta.dir, "..", "src/server/daemon.ts"), "utf8");
    expect(src).toContain("setNarrationSink(log)");
  });

  test("a flag naming nothing SAYS so - a silent no-op is the failure this list exists to prevent", () => {
    expect(unknownSubsystems({ LUCID_VERBOSE: "1" })).toEqual(["1"]);
    expect(unknownSubsystems({ LUCID_VERBOSE: "anchor" })).toEqual(["anchor"]);
    expect(unknownSubsystems({ LUCID_VERBOSE: "anchors,attend" })).toEqual([]);
    expect(unknownSubsystems({ LUCID_VERBOSE: "all" })).toEqual([]);
    expect(unknownSubsystems({})).toEqual([]);
  });

  test("resolution is LAZY - a flag set after import still takes effect", () => {
    // Snapshotting at construction made the flag depend on import order, and
    // put a bare process.env in a module the BROWSER overlay bundles.
    const built = tracer("anchors", { sink: () => {} });
    const prev = process.env.LUCID_VERBOSE;
    const lines: string[] = [];
    process.env.LUCID_VERBOSE = "anchors";
    try {
      const late = tracer("anchors", { sink: (l) => void lines.push(l) });
      late(() => "resolved on first use");
      expect(lines).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.LUCID_VERBOSE;
      else process.env.LUCID_VERBOSE = prev;
    }
    expect(typeof built).toBe("function");
  });
});

describe("narration cannot be laundered into the review log (M3.1, #91 review)", () => {
  test("a quiet turn's relayed reply strips Lucid's own trace lines", async () => {
    const { relayableTail } = await import("../src/server/attend.ts");
    // LUCID_VERBOSE propagates into the spawned turn, whose stderr IS the
    // attend log - so the tail of a quiet turn can be pure narration, and it
    // used to be delivered as an agent_reply the human sees in the viewer.
    const output = [
      "[anchors] lucidId absent on the anchor, skipped",
      "[anchors] fingerprint p#ab12 -> 1 match, exact",
      "[attend] plan: spawning",
    ].join("\n");
    expect(relayableTail(output)).toBe("");

    // A real reply still comes through, narration around it stripped.
    const mixed = [
      "[anchors] noise",
      "No conversation found with session ID: abc",
      "[attend] x",
    ].join("\n");
    expect(relayableTail(mixed)).toBe("No conversation found with session ID: abc");
  });
});

describe("trace fields are capped like record fields are (M3.1, #91 review)", () => {
  test("an off-shape fingerprint from the wire cannot write an oversized line", async () => {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML("<html><body><p>x</p></body></html>");
    const lines: string[] = [];
    resolveElementMatch(
      { type: "element", fingerprint: "z".repeat(5000), lucidId: "y".repeat(5000) } as never,
      document as never,
      {
        trace: tracer("anchors", {
          env: { LUCID_VERBOSE: "anchors" },
          sink: (l) => void lines.push(l),
        }),
      },
    );
    // Narration shares the hub's 5MB rotation budget and rides at poll rate.
    for (const line of lines) expect(line.length).toBeLessThan(300);
  });
});

describe("an unrecognised subsystem is REPORTED, wherever the process narrates (#91 re-review)", () => {
  test("the warning rides the narration sink, not a stderr the hub discards", () => {
    // The fix for "a typo silently means off" was itself silently discarded:
    // routed to stderr, which is /dev/null for a detached hub - the same
    // defect MAJOR 1 fixed, surviving inside MAJOR 1's own fix, one line
    // after the correct sink had already been installed.
    const prev = process.env.LUCID_VERBOSE;
    process.env.LUCID_VERBOSE = "1";
    const lines: string[] = [];
    let restore = (): void => {};
    try {
      restore = setNarrationSink((l) => void lines.push(l));
      resetUnknownWarning();
      warnUnknownSubsystems();
      expect(lines.join("\n")).toContain('"1"');
      expect(lines.join("\n")).toContain("not a subsystem");
      // Once per process, not once per call.
      warnUnknownSubsystems();
      expect(lines).toHaveLength(1);
    } finally {
      restore();
      resetUnknownWarning();
      if (prev === undefined) delete process.env.LUCID_VERBOSE;
      else process.env.LUCID_VERBOSE = prev;
    }
  });

  test("a well-formed flag warns about nothing", () => {
    const prev = process.env.LUCID_VERBOSE;
    process.env.LUCID_VERBOSE = "anchors,attend";
    const lines: string[] = [];
    let restore = (): void => {};
    try {
      restore = setNarrationSink((l) => void lines.push(l));
      resetUnknownWarning();
      warnUnknownSubsystems();
      expect(lines).toEqual([]);
    } finally {
      restore();
      resetUnknownWarning();
      if (prev === undefined) delete process.env.LUCID_VERBOSE;
      else process.env.LUCID_VERBOSE = prev;
    }
  });
});
