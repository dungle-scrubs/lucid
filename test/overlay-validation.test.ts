import { describe, expect, test } from "bun:test";
import {
  validateOverlayMessage,
  MAX_OVERLAY_SECTION_IDS,
  MAX_SELECTION_COPY_TEXT,
  type OverlayValidationRecord,
} from "../client/shared/protocol.ts";

const records: OverlayValidationRecord[] = [];

const validate = (data: unknown): ReturnType<typeof validateOverlayMessage> => {
  records.length = 0;
  return validateOverlayMessage(data, (record) => records.push(record));
};

describe("validateOverlayMessage", () => {
  test("accepts a well-formed ready message", () => {
    expect(validate({ source: "lucid-overlay", type: "ready" })?.type).toBe("ready");
    expect(records).toEqual([]);
  });

  test("accepts a content-width with a positive finite width", () => {
    const result = validate({ source: "lucid-overlay", type: "content-width", width: 700 });
    expect(result?.type).toBe("content-width");
    if (result?.type === "content-width") expect(result.width).toBe(700);
    expect(records).toEqual([]);
  });

  test("refuses a non-finite width (NaN, Infinity) before it reaches layout math", () => {
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(validate({ source: "lucid-overlay", type: "content-width", width })).toBeNull();
    }
    expect(records.every((r) => r.kind === "refusal" && r.type === "content-width")).toBe(true);
  });

  test("refuses a zero or negative width as today", () => {
    expect(validate({ source: "lucid-overlay", type: "content-width", width: 0 })).toBeNull();
    expect(validate({ source: "lucid-overlay", type: "content-width", width: -1 })).toBeNull();
  });

  test("truncates section-ids above the bound and records the original vs kept counts", () => {
    const many = Array.from({ length: MAX_OVERLAY_SECTION_IDS + 100 }, (_, i) => `s${i}`);
    const result = validate({ source: "lucid-overlay", type: "section-ids", ids: many });
    expect(result?.type).toBe("section-ids");
    if (result?.type === "section-ids") expect(result.ids).toHaveLength(MAX_OVERLAY_SECTION_IDS);
    expect(records).toEqual([
      {
        kind: "truncation",
        type: "section-ids",
        field: "ids",
        kept: MAX_OVERLAY_SECTION_IDS,
        original: MAX_OVERLAY_SECTION_IDS + 100,
      },
    ]);
  });

  test("accepts section-ids at exactly the bound without truncation", () => {
    const atLimit = Array.from({ length: MAX_OVERLAY_SECTION_IDS }, (_, i) => `s${i}`);
    const result = validate({ source: "lucid-overlay", type: "section-ids", ids: atLimit });
    expect(result?.type).toBe("section-ids");
    expect(records).toEqual([]);
  });

  test("refuses a message with the wrong source", () => {
    expect(validate({ source: "lucid-chrome", type: "ready" })).toBeNull();
  });

  test("refuses a message with an unknown type", () => {
    expect(validate({ source: "lucid-overlay", type: "forged" })).toBeNull();
  });

  test("refuses a non-object payload", () => {
    expect(validate(null)).toBeNull();
    expect(validate("string")).toBeNull();
    expect(validate(undefined)).toBeNull();
  });

  test("refuses a pong without a nonce", () => {
    expect(validate({ source: "lucid-overlay", type: "pong" })).toBeNull();
    expect(validate({ source: "lucid-overlay", type: "pong", nonce: 42 })).toBeNull();
  });

  describe("selection-copy", () => {
    // The selection text plus the release coordinates, posted from the
    // opaque-origin overlay to the parent chrome so a Copy Popover can open at
    // the release point. The parent CANNOT read the iframe's selection (opaque
    // origin), so the text is untrusted input at this boundary and is gated
    // exactly like every other overlay message: right shape, finite coords,
    // bounded non-empty text. The validator is the only thing standing between
    // a hostile realm and a Popover opening at attacker-chosen coordinates.
    test("accepts a well-formed selection-copy", () => {
      const result = validate({
        source: "lucid-overlay",
        type: "selection-copy",
        text: "zero downtime",
        x: 123,
        y: 45,
      });
      expect(result?.type).toBe("selection-copy");
      if (result?.type === "selection-copy") {
        expect(result.text).toBe("zero downtime");
        expect(result.x).toBe(123);
        expect(result.y).toBe(45);
      }
      expect(records).toEqual([]);
    });

    test("refuses a payload missing any required field", () => {
      expect(validate({ source: "lucid-overlay", type: "selection-copy", x: 1, y: 2 })).toBeNull();
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: "a", y: 2 }),
      ).toBeNull();
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: "a", x: 1 }),
      ).toBeNull();
      expect(records.every((r) => r.kind === "refusal" && r.type === "selection-copy")).toBe(true);
    });

    test("refuses empty text - a bare click offers nothing to copy", () => {
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: "", x: 1, y: 2 }),
      ).toBeNull();
      // A whitespace-only selection is not a real selection either: the
      // overlay posts nothing for a collapsed range, and a stray newline must
      // not open a Popover with nothing to copy.
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: "   ", x: 1, y: 2 }),
      ).toBeNull();
    });

    test("refuses non-finite coordinates before they reach anchor math", () => {
      for (const coord of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(
          validate({ source: "lucid-overlay", type: "selection-copy", text: "a", x: coord, y: 1 }),
        ).toBeNull();
        expect(
          validate({ source: "lucid-overlay", type: "selection-copy", text: "a", x: 1, y: coord }),
        ).toBeNull();
      }
    });

    test("refuses non-number coordinates (a forged string, null, bool)", () => {
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: "a", x: "1", y: 2 }),
      ).toBeNull();
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: "a", x: 1, y: null }),
      ).toBeNull();
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: "a", x: true, y: 2 }),
      ).toBeNull();
    });

    test("refuses non-string text", () => {
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: 42, x: 1, y: 2 }),
      ).toBeNull();
      expect(
        validate({ source: "lucid-overlay", type: "selection-copy", text: null, x: 1, y: 2 }),
      ).toBeNull();
    });

    test("truncates over-length text and records the original vs kept counts", () => {
      const over = "x".repeat(MAX_SELECTION_COPY_TEXT + 50);
      const result = validate({
        source: "lucid-overlay",
        type: "selection-copy",
        text: over,
        x: 1,
        y: 2,
      });
      expect(result?.type).toBe("selection-copy");
      if (result?.type === "selection-copy") {
        expect(result.text).toHaveLength(MAX_SELECTION_COPY_TEXT);
        expect(result.text).toBe("x".repeat(MAX_SELECTION_COPY_TEXT));
      }
      expect(records).toEqual([
        {
          kind: "truncation",
          type: "selection-copy",
          field: "text",
          kept: MAX_SELECTION_COPY_TEXT,
          original: MAX_SELECTION_COPY_TEXT + 50,
        },
      ]);
    });

    test("accepts text at exactly the bound without truncation", () => {
      const atLimit = "x".repeat(MAX_SELECTION_COPY_TEXT);
      const result = validate({
        source: "lucid-overlay",
        type: "selection-copy",
        text: atLimit,
        x: 1,
        y: 2,
      });
      expect(result?.type).toBe("selection-copy");
      if (result?.type === "selection-copy")
        expect(result.text).toHaveLength(MAX_SELECTION_COPY_TEXT);
      expect(records).toEqual([]);
    });
  });
});
