import { describe, expect, test } from "bun:test";
import { THEME_PALETTE, THEME_TOKENS, type ThemeName } from "../src/core/palette.ts";
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

/**
 * A rendered plan is read in two places: straight off disk, and inside the
 * viewer, which injects `:root[data-lucid-theme="…"]` for the six tokens it
 * remaps (src/core/palette.ts). That selector outranks the plan's own `:root`,
 * so any of the six the plan declares with a value of its own would be
 * OVERWRITTEN in the viewer - one document, two appearances, with nothing red.
 *
 * So the rule is a value one, not a naming one: declare whichever of the six
 * you like, as long as you declare the palette's value for it. The plan
 * declares exactly one, `--ink`, and its value is the palette's in both forms.
 */
describe("a rendered plan reads the same from disk as it does in the viewer", () => {
  /** `:root { … }` at the top, and the one inside the dark media block. */
  const blocks = (): Record<ThemeName, string> => {
    const css = (/<style>([\s\S]*?)<\/style>/.exec(renderPlanDoc("# Plan")) ?? [])[1] ?? "";
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const roots = [...bare.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
    return { dark: roots[1] ?? "", light: roots[0] ?? "" };
  };

  /** Colour values differ only in the spacing an author happened to type. */
  const same = (a: string, b: string): boolean => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

  for (const theme of ["light", "dark"] as const) {
    test(`every remapped token the ${theme} block declares carries the palette's value`, () => {
      const block = blocks()[theme];
      expect(block, `no ${theme} :root block in the rendered plan`).not.toBe("");
      for (const token of THEME_TOKENS) {
        const declared = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(block)?.[1]?.trim();
        if (declared === undefined) continue;
        const wanted = THEME_PALETTE[theme][token];
        expect(
          same(declared, wanted),
          `${theme} ${token} is ${declared}, but the viewer remaps it to ${wanted} - ` +
            "the plan would look different in Lucid than it does from disk",
        ).toBe(true);
      }
    });
  }

  test("the plan declares --ink, so an artifact viewer can see it routes colour", () => {
    // Not decoration: `cascadeDeclaresTokens` in client/overlay/artifact-theme.ts
    // asks the resolved cascade whether ANY of the six is declared.
    expect(blocks().light).toContain("--ink:");
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
