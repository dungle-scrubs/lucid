import { describe, expect, test } from "bun:test";
import { sseMaxBackoffFromEnv } from "../src/server/viewer.ts";

describe("the LUCID_SSE_MAX_BACKOFF_MS seam parses strictly", () => {
  test("a whole positive number is the cap", () => {
    expect(sseMaxBackoffFromEnv({ LUCID_SSE_MAX_BACKOFF_MS: "250" })).toBe(250);
  });

  test("a typo half-parses to nothing, not to its prefix", () => {
    // parseInt("5s") is 5, which silently applies a fifth of nobody's intent.
    expect(sseMaxBackoffFromEnv({ LUCID_SSE_MAX_BACKOFF_MS: "5s" })).toBeUndefined();
    expect(sseMaxBackoffFromEnv({ LUCID_SSE_MAX_BACKOFF_MS: "250ms" })).toBeUndefined();
    expect(sseMaxBackoffFromEnv({ LUCID_SSE_MAX_BACKOFF_MS: " 250" })).toBeUndefined();
  });

  test("zero and absent both mean production behaviour", () => {
    // A zero-delay reconnect loop is a busy-wait against a dead server;
    // refusing 0 keeps the knob unable to make the product worse.
    expect(sseMaxBackoffFromEnv({ LUCID_SSE_MAX_BACKOFF_MS: "0" })).toBeUndefined();
    expect(sseMaxBackoffFromEnv({})).toBeUndefined();
  });
});
