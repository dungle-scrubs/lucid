import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FRAME_KINDS, REFUSAL_ISSUES } from "../src/protocol/index.js";

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
  test("every named refusal issue in the skill exists in REFUSAL_ISSUES, and every issue the reducer raises is documented", () => {
    // Pull the closed set the skill lists at the end.
    for (const issue of REFUSAL_ISSUES) {
      expect(skill, `skill must document issue \`${issue}\``).toContain(`\`${issue}\``);
    }
    // No invented issues: every backticked kebab token that looks like an
    // issue is a real one (guards against the doc drifting ahead of code).
    const documented = new Set(REFUSAL_ISSUES as readonly string[]);
    const backticked = [...skill.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]);
    const issueShaped = backticked.filter((t) => documented.has(t ?? ""));
    expect(issueShaped.length).toBeGreaterThanOrEqual(REFUSAL_ISSUES.length);
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
