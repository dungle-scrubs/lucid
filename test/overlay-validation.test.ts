import { describe, expect, test } from "bun:test";
import {
  validateOverlayMessage,
  MAX_OVERLAY_SECTION_IDS,
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
});
