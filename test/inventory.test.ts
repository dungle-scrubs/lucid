import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_EXTS,
  classifyLucidRecord,
  probeForLucidRecord,
  type ArtifactProbe,
} from "../src/core/inventory.ts";

/**
 * The record-layout classifier the migration rests on.
 *
 * The one axis that matters, and the easiest to get backwards: a record under a
 * `.lucid/<stem>/` dir is `canonical` when its artifact lives INSIDE that
 * `.lucid`, and `nested` when the artifact is outside it. Getting this wrong
 * moves an artifact the migration should have left alone, or leaves one it
 * should have moved.
 */

describe("probeForLucidRecord names the two artifact locations", () => {
  test("inside .lucid is canonical's home; beside the .lucid dir is nested's", () => {
    const probe = probeForLucidRecord("/p/.lucid/plan/log.ndjson");
    expect(probe.insideLucid).toEqual(["/p/.lucid/plan.html", "/p/.lucid/plan.md"]);
    expect(probe.besideRecord).toEqual(["/p/plan.html", "/p/plan.md"]);
  });

  test("every artifact extension is probed", () => {
    const probe = probeForLucidRecord("/p/.lucid/x/log.ndjson");
    for (const ext of ARTIFACT_EXTS) {
      expect(probe.insideLucid.some((p) => p.endsWith(`x${ext}`))).toBe(true);
    }
  });
});

describe("classifyLucidRecord", () => {
  const probe: ArtifactProbe = {
    insideLucid: ["/p/.lucid/plan.html"],
    besideRecord: ["/p/plan.html"],
  };

  test("artifact inside .lucid is canonical", () => {
    expect(classifyLucidRecord(probe, new Set(["/p/.lucid/plan.html"]))).toBe("canonical");
  });

  test("artifact outside .lucid is nested", () => {
    expect(classifyLucidRecord(probe, new Set(["/p/plan.html"]))).toBe("nested");
  });

  test("canonical wins when BOTH exist - the artifact inside .lucid is the live one", () => {
    // A half-migrated record can have both; the inside-.lucid copy is the one
    // the canonical layout serves, so it decides.
    expect(classifyLucidRecord(probe, new Set(["/p/.lucid/plan.html", "/p/plan.html"]))).toBe(
      "canonical",
    );
  });

  test("neither present is unknown - an orphaned record, listed never adopted", () => {
    // D-011: a record whose artifact is gone is reported, not guessed at.
    expect(classifyLucidRecord(probe, new Set())).toBe("unknown");
  });
});
