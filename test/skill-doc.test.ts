import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ANNOTATION_FENCE } from "../src/protocol/annotations.js";
import { DECODE_ISSUES, FRAME_KINDS, REFUSAL_ISSUES } from "../src/protocol/index.js";

const skill = readFileSync(
  fileURLToPath(new URL("../docs/skill-chat-substrate.md", import.meta.url)),
  "utf8",
);

/**
 * The skill is documentation, but its VOCABULARY is verifiable: every
 * refusal issue and frame kind it names must exist in the code, and every
 * refusal issue the code can raise must be documented - so the contract an
 * agent reads can never drift from the contract lucid enforces.
 */
describe("milestone-1 skill doc (M6.2)", () => {
  test("every issue the code can raise (refusal AND decode) is documented, and the doc invents no issue the code lacks", () => {
    const allIssues = new Set<string>([...REFUSAL_ISSUES, ...DECODE_ISSUES]);
    // code -> doc: every real issue appears backticked in the skill.
    for (const issue of allIssues) {
      expect(skill, `skill must document issue \`${issue}\``).toContain(`\`${issue}\``);
    }

    // doc -> code (the real anti-drift guard): every backticked kebab
    // token that is NOT a known non-issue term MUST be a real issue. A
    // fabricated `made-up-issue` in the doc fails here.
    const NON_ISSUE_TERMS = new Set([
      ANNOTATION_FENCE,
      "headless-session",
      "headless-turn",
      "attach-ok",
      "event-ack",
      "switch-path",
      "wait-poll",
      "runtime-verified",
      "setting-sources",
      "lucid-aware",
      "text-delta", // (not used, but a plausible kebab term)
    ]);
    const backticked = [...skill.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1] ?? "");
    const unknown = backticked.filter((t) => !allIssues.has(t) && !NON_ISSUE_TERMS.has(t));
    expect(unknown, `skill has issue-shaped tokens not in the code: ${unknown.join(", ")}`).toEqual(
      [],
    );
  });

  test("the skill documents the load-bearing frame kinds and the single-writer/epoch rule", () => {
    for (const kind of ["attach", "event", "ack", "disposition", "heartbeat", "detach"]) {
      expect(FRAME_KINDS).toContain(kind as (typeof FRAME_KINDS)[number]);
      expect(skill, `skill must mention frame \`${kind}\``).toContain(kind);
    }
    // The core invariants an agent must not violate.
    expect(skill).toContain("exactly one");
    expect(skill).toContain("epoch");
    expect(skill.toLowerCase()).toMatch(/never\s+half-appl/);
    expect(skill).toContain("runtime-verified");
    // Capability source honesty and the ladder.
    for (const rung of ["hooks", "cooperative", "observe"]) expect(skill).toContain(rung);
  });
});
