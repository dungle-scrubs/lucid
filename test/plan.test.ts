import { describe, expect, test } from "bun:test";
import type { WaitPayload } from "../src/core/payload.ts";
import { ingestPayload } from "../src/plan/ingest.ts";
import { renderPlanDoc } from "../src/plan/render.ts";

describe("renderPlanDoc", () => {
  test("D-NNN markers become data-lucid-id anchors", () => {
    const md = [
      "## Design",
      "",
      "<!-- D-001 -->",
      "The CLI is a single Bun binary.",
      "",
      "<!-- D-014 -->",
      "Credit overflow caps and refunds.",
    ].join("\n");
    const html = renderPlanDoc(md, { title: "T", stage: "review" });
    expect(html).toContain('data-lucid-id="D-001"');
    expect(html).toContain('data-lucid-id="D-014"');
    expect(html).toContain("data-lucid-decision");
    expect(html).toContain("The CLI is a single Bun binary.");
    // the marker comment itself is consumed
    expect(html).not.toContain("<!-- D-001 -->");
  });

  test("open questions become addressable Q-N items", () => {
    const md = [
      "## Open Questions",
      "",
      "1. Should we support Windows?",
      "2. What port range?",
    ].join("\n");
    const html = renderPlanDoc(md);
    expect(html).toContain('data-lucid-id="Q-1"');
    expect(html).toContain('data-lucid-id="Q-2"');
    expect(html).toContain("data-lucid-question");
  });
});

describe("ingestPayload", () => {
  const payload = (): WaitPayload => ({
    session: "/x/plan.lucid.html",
    version: 2,
    status: "feedback",
    nextCursor: "evt_00005",
    reviewResolved: true,
    annotations: [
      {
        id: "a1",
        version: 2,
        resolved: true,
        target: {
          kind: "element",
          lucidId: "D-014",
          fingerprint: "f",
          domPath: "p",
          snippet: "<p>cap+refund</p>",
        },
        note: "disagree - should throw instead",
        at: "t",
      },
      {
        id: "a2",
        version: 2,
        resolved: true,
        target: {
          kind: "element",
          lucidId: "Q-1",
          fingerprint: "f",
          domPath: "li",
          snippet: "<li>Windows?</li>",
        },
        note: "no - macOS and Linux only for v0.1",
        at: "t",
      },
      {
        id: "a3",
        version: 2,
        resolved: true,
        target: {
          kind: "range",
          quote: { exact: "zero downtime", prefix: "", suffix: "" },
          position: { start: 0, end: 0 },
          snippet: "zero downtime",
        },
        note: "is this really required?",
        at: "t",
      },
    ],
    messages: [{ role: "human", text: "tighten phase 2 overall", at: "t", seq: 1 }],
  });

  test("maps each annotation to the right plan-db command by ledger ref", () => {
    const r = ingestPayload(payload(), "lucid");
    expect(r.plan).toBe("lucid");

    const dec = r.items.find((i) => i.ref === "D-014");
    expect(dec?.kind).toBe("decision-feedback");

    const q = r.items.find((i) => i.ref === "Q-1");
    expect(q?.kind).toBe("question-answer");

    expect(r.items.some((i) => i.kind === "located-note")).toBe(true);
    expect(r.items.some((i) => i.kind === "message")).toBe(true);
    expect(r.items.some((i) => i.kind === "approve")).toBe(true);

    // a question answer becomes a recorded decision; a decision note becomes a finding
    expect(
      r.commands.some((c) => c.includes("record-decision") && c.includes("macOS and Linux")),
    ).toBe(true);
    expect(r.commands.some((c) => c.includes("add-finding") && c.includes("D-014"))).toBe(true);
  });

  test("the snippet a command carries is the target's visible text, not its markup", () => {
    // `--topic "<li>Windows?</li>"` put a tag in the ledger (#12). An element
    // snippet is outerHTML; what the human pointed at is what it shows.
    const r = ingestPayload(payload(), "lucid");
    const q = r.items.find((i) => i.ref === "Q-1");
    expect(q?.snippet).toBe("Windows?");
    expect(r.commands.some((c) => c.includes("<li>"))).toBe(false);
  });
});
