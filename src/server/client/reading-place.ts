import { tryCatch } from "./try-catch.js";

export interface ReadingPlace {
  readonly index: number;
  readonly top: number;
}

export const readingPlaceKey = (
  conversationId: string,
  artifactId: string,
  version: number,
): string => `lucid.readingPlace:${JSON.stringify([conversationId, artifactId, version])}`;

export const validReadingPlace = (raw: unknown): raw is ReadingPlace => {
  if (raw === null || typeof raw !== "object") return false;
  const place = raw as Record<string, unknown>;
  return (
    typeof place.index === "number" &&
    Number.isSafeInteger(place.index) &&
    place.index >= 0 &&
    typeof place.top === "number" &&
    Number.isFinite(place.top)
  );
};

export const readReadingPlace = (
  storage: () => Pick<Storage, "getItem">,
  key: string,
): ReadingPlace | null => {
  const [error, value] = tryCatch((): unknown => JSON.parse(storage().getItem(key) ?? "null"));
  return !error && validReadingPlace(value) ? { index: value.index, top: value.top } : null;
};

export const writeReadingPlace = (
  storage: () => Pick<Storage, "setItem">,
  key: string,
  place: ReadingPlace,
): void => {
  if (!validReadingPlace(place)) return;
  // A blocked getter, quota, or disabled storage must not interrupt reading.
  tryCatch(() => storage().setItem(key, JSON.stringify({ index: place.index, top: place.top })));
};
