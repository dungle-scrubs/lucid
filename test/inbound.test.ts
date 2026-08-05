import { describe, expect, test } from "bun:test";
import {
  decodeAck,
  decodeAnchorList,
  decodeAnnotation,
  decodeAuthoredAt,
  decodeFork,
  decodeImages,
  decodeMessage,
  decodeReply,
  decodeRevert,
  decodeTurnEnded,
  decodeVersion,
  MAX_ANCHORS,
} from "../src/protocol/inbound.ts";

/**
 * Table tests for the inbound decoders (M5.2). Each route has accept and
 * refuse cases. The decoder never throws - a malformed body is a refusal.
 */

const validAnchor = {
  kind: "element" as const,
  fingerprint: "fp",
  domPath: "body/p",
  snippet: "hello",
};

describe("decodeVersion", () => {
  test("accepts a positive integer", () => {
    expect(decodeVersion(3)).toBe(3);
  });
  test("accepts zero", () => {
    expect(decodeVersion(0)).toBe(0);
  });
  test("defaults to 0 for non-integer", () => {
    expect(decodeVersion(3.5)).toBe(0);
  });
  test("defaults to 0 for non-number", () => {
    expect(decodeVersion("3")).toBe(0);
    expect(decodeVersion(undefined)).toBe(0);
  });
});

describe("decodeAuthoredAt", () => {
  test("accepts a parseable ISO timestamp", () => {
    expect(decodeAuthoredAt("2024-01-15T10:30:00Z")).toBe("2024-01-15T10:30:00Z");
  });
  test("returns undefined for unparseable", () => {
    expect(decodeAuthoredAt("not a date")).toBeUndefined();
  });
  test("returns undefined for absent", () => {
    expect(decodeAuthoredAt(undefined)).toBeUndefined();
  });
  test("returns undefined for too long", () => {
    expect(decodeAuthoredAt("x".repeat(41))).toBeUndefined();
  });
});

describe("decodeImages", () => {
  test("accepts a well-formed image manifest", () => {
    const result = decodeImages([{ id: "img1", name: "screenshot.png", file: "abc-123.png" }]);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("img1");
  });
  test("returns empty for non-array", () => {
    expect(decodeImages(undefined)).toEqual([]);
    expect(decodeImages("not array")).toEqual([]);
  });
  test("drops malformed entries silently", () => {
    expect(decodeImages([{ id: "x" }, null, { bad: true }])).toEqual([]);
  });
});

describe("decodeAnchorList", () => {
  test("returns undefined when absent", () => {
    expect(decodeAnchorList(undefined, "targets")).toBeUndefined();
  });
  test("returns undefined for empty array", () => {
    expect(decodeAnchorList([], "targets")).toBeUndefined();
  });
  test("refuses non-array", () => {
    const result = decodeAnchorList("not array", "targets");
    expect(result && "ok" in result && !result.ok).toBe(true);
  });
  test(`refuses more than MAX_ANCHORS (${MAX_ANCHORS}) entries`, () => {
    const tooMany = Array.from({ length: MAX_ANCHORS + 1 }, () => ({ ...validAnchor }));
    const result = decodeAnchorList(tooMany, "targets");
    expect(result && "ok" in result && !result.ok).toBe(true);
  });
});

describe("decodeAnnotation", () => {
  const validBody = {
    id: "ann-1",
    note: "fix this",
    target: validAnchor,
    version: 1,
  };

  test("accepts a minimal valid body", () => {
    const result = decodeAnnotation(validBody);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.t).toBe("annotation");
      expect(result.value.id).toBe("ann-1");
      expect(result.value.note).toBe("fix this");
    }
  });

  test("accepts targets list and derives target as first", () => {
    const result = decodeAnnotation({
      id: "ann-2",
      note: "multi",
      targets: [validAnchor, { ...validAnchor, fingerprint: "fp2" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.target).toEqual(validAnchor);
      expect(result.value.targets).toHaveLength(2);
    }
  });

  test("normalizes singleton targets to no targets field", () => {
    const result = decodeAnnotation({
      id: "ann-3",
      note: "one",
      targets: [validAnchor],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.target).toEqual(validAnchor);
      expect(result.value.targets).toBeUndefined();
    }
  });

  test("refuses null body", () => {
    expect(decodeAnnotation(null).ok).toBe(false);
  });

  test("refuses missing id", () => {
    expect(decodeAnnotation({ note: "x", target: validAnchor }).ok).toBe(false);
  });

  test("refuses missing note", () => {
    expect(decodeAnnotation({ id: "x", target: validAnchor }).ok).toBe(false);
  });

  test("refuses missing target when no targets list", () => {
    const result = decodeAnnotation({ id: "x", note: "y" });
    expect(result.ok).toBe(false);
  });

  test("carries authoredAt and images through", () => {
    const result = decodeAnnotation({
      ...validBody,
      authoredAt: "2024-01-15T10:30:00Z",
      images: [{ id: "img1", name: "pic.png", file: "abc-123.png" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.authoredAt).toBe("2024-01-15T10:30:00Z");
      expect(result.value.images).toHaveLength(1);
    }
  });
});

describe("decodeFork", () => {
  test("accepts a valid fork with safe id", () => {
    const result = decodeFork({ id: "fork-1", note: "branch here", target: validAnchor });
    expect(result.ok).toBe(true);
  });
  test("refuses unsafe id (path separators)", () => {
    expect(decodeFork({ id: "../evil", note: "x", target: validAnchor }).ok).toBe(false);
  });
  test("refuses empty note", () => {
    expect(decodeFork({ id: "f1", note: "  ", target: validAnchor }).ok).toBe(false);
  });
});

describe("decodeMessage", () => {
  test("accepts a valid message", () => {
    const result = decodeMessage({ id: "m1", text: "hello world" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.text).toBe("hello world");
  });
  test("refuses blank text with no images", () => {
    expect(decodeMessage({ id: "m1", text: "  " }).ok).toBe(false);
  });
  test("carries refs as strings only", () => {
    const result = decodeMessage({ id: "m1", text: "hi", refs: ["a", 42, "b"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.refs).toEqual(["a", "b"]);
  });
});

describe("decodeRevert", () => {
  test("accepts a valid revert", () => {
    const result = decodeRevert({ id: "r1", why: "typo", targetVersion: 3, target: validAnchor });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.targetVersion).toBe(3);
  });
  test("refuses missing why", () => {
    expect(decodeRevert({ id: "r1", targetVersion: 3, target: validAnchor }).ok).toBe(false);
  });
});

describe("decodeReply", () => {
  test("accepts a valid reply", () => {
    const result = decodeReply({ id: "rep1", text: "done" });
    expect(result.ok).toBe(true);
  });
  test("refuses missing text", () => {
    expect(decodeReply({ id: "rep1" }).ok).toBe(false);
  });
});

describe("decodeAck", () => {
  test("accepts a minimal ack", () => {
    const result = decodeAck({ id: "ack1" });
    expect(result.ok).toBe(true);
  });
  test("accepts intent and covers", () => {
    const result = decodeAck({ id: "ack1", intent: "revise", covers: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.intent).toBe("revise");
      expect(result.value.covers).toBe(5);
    }
  });
  test("drops non-integer covers", () => {
    const result = decodeAck({ id: "ack1", covers: 3.5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.covers).toBeUndefined();
  });
  test("drops negative covers", () => {
    const result = decodeAck({ id: "ack1", covers: -1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.covers).toBeUndefined();
  });
});

describe("decodeTurnEnded", () => {
  test("accepts a valid turn-ended", () => {
    const result = decodeTurnEnded({ turnId: "t1", reason: "done" });
    expect(result.ok).toBe(true);
  });
  test("refuses unknown reason", () => {
    expect(decodeTurnEnded({ turnId: "t1", reason: "mystery" }).ok).toBe(false);
  });
  test("refuses empty turnId", () => {
    expect(decodeTurnEnded({ turnId: "", reason: "done" }).ok).toBe(false);
  });
  test("accepts optional code", () => {
    const result = decodeTurnEnded({ turnId: "t1", reason: "failed", code: "OOM" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.code).toBe("OOM");
  });
  test("refuses malformed code", () => {
    expect(decodeTurnEnded({ turnId: "t1", reason: "done", code: "has spaces" }).ok).toBe(false);
  });
});
