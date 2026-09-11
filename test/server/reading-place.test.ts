import { describe, expect, test } from "bun:test";
import {
  readingPlaceKey,
  readReadingPlace,
  writeReadingPlace,
} from "../../src/server/client/reading-place.js";

describe("reading place across reload", () => {
  test("a new page restores the exact block offset for the same artifact version", () => {
    const values = new Map<string, string>();
    const storage = () => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    });
    const key = readingPlaceKey("conversation", "document", 4);
    const place = { index: 12, top: -43.625 };
    writeReadingPlace(storage, key, place);
    expect(readReadingPlace(storage, key)).toEqual(place);
    expect(readReadingPlace(storage, readingPlaceKey("other", "document", 4))).toBeNull();
    expect(readReadingPlace(storage, readingPlaceKey("conversation", "other", 4))).toBeNull();
    expect(readReadingPlace(storage, readingPlaceKey("conversation", "document", 5))).toBeNull();
    writeReadingPlace(storage, key, { index: 0, top: 0 });
    expect(readReadingPlace(storage, key)).toEqual({ index: 0, top: 0 });
  });

  test.each([
    "broken",
    "null",
    "{}",
    '{"index":-1,"top":0}',
    '{"index":1.5,"top":0}',
    '{"index":1,"top":"0"}',
    '{"index":1,"top":1e999}',
  ])("ignores malformed saved position %s", (raw) => {
    expect(readReadingPlace(() => ({ getItem: () => raw }), "key")).toBeNull();
  });

  test("blocked browser storage does not break reading", () => {
    const blocked = (): never => {
      throw new Error("Storage blocked");
    };
    expect(readReadingPlace(blocked, "key")).toBeNull();
    expect(() => writeReadingPlace(blocked, "key", { index: 1, top: 0 })).not.toThrow();
  });
});
