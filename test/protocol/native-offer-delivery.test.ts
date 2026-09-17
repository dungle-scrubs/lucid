import { expect, test } from "bun:test";
import { parseConnectionFact } from "../../src/protocol/connection.js";

const offerStarted = (delivery?: unknown) => ({
  actionId: crypto.randomUUID(),
  kind: "offer-started",
  offer: {
    attempt: 1,
    context: { digest: "a".repeat(64), from: 0, through: 4 },
    ...(delivery === undefined ? {} : { delivery }),
    epoch: 1,
    id: crypto.randomUUID(),
    inputId: "input-1",
    participationId: crypto.randomUUID(),
    turnId: "turn-1",
  },
  stamp: "b".repeat(64),
});

test("an offer without delivery parses as inline and keeps no delivery field", () => {
  const parsed = parseConnectionFact(offerStarted());
  expect(parsed?.kind).toBe("offer-started");
  if (parsed?.kind !== "offer-started") throw new Error("Missing offer");
  expect("delivery" in parsed.offer).toBe(false);
});

test("a reference delivery parses only in its exact shape", () => {
  const parsed = parseConnectionFact(offerStarted({ bytes: 77_379, kind: "reference" }));
  if (parsed?.kind !== "offer-started") throw new Error("Missing offer");
  expect(parsed.offer.delivery).toEqual({ bytes: 77_379, kind: "reference" });
  for (const malformed of [
    null,
    "reference",
    { kind: "reference" },
    { bytes: 0, kind: "reference" },
    { bytes: -1, kind: "reference" },
    { bytes: 1.5, kind: "reference" },
    { bytes: Number.MAX_SAFE_INTEGER + 1, kind: "reference" },
    { bytes: "10", kind: "reference" },
    { bytes: 10, kind: "inline" },
    { bytes: 10, kind: "reference", path: "/tmp/copy" },
  ])
    expect(parseConnectionFact(offerStarted(malformed))).toBeNull();
});
