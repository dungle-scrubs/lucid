import { describe, expect, test } from "bun:test";
import { renderShellPage, sseMaxBackoffFromEnv, streamCapFromEnv } from "../src/server/viewer.ts";

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

describe("the LUCID_STREAM_CAP seam", () => {
  test("a positive integer is the cap; anything else leaves the client's default", () => {
    expect(streamCapFromEnv({ LUCID_STREAM_CAP: "3" })).toBe(3);
    expect(streamCapFromEnv({ LUCID_STREAM_CAP: "0" })).toBeUndefined();
    expect(streamCapFromEnv({ LUCID_STREAM_CAP: "2.5" })).toBeUndefined();
    expect(streamCapFromEnv({ LUCID_STREAM_CAP: "lots" })).toBeUndefined();
    expect(streamCapFromEnv({})).toBeUndefined();
  });

  test("the shell page carries the config as JSON off the declared type", () => {
    // Hand-concatenated fragments are how the server's spelling and the
    // client's drift; the payload is serialized from ShellConfig itself.
    const previous = process.env.LUCID_STREAM_CAP;
    process.env.LUCID_STREAM_CAP = "4";
    try {
      const html = renderShellPage();
      expect(html).toContain('window.__LUCID_SHELL__ = {"mode":"shell"');
      expect(html).toContain('"streamCap":4');
    } finally {
      if (previous === undefined) delete process.env.LUCID_STREAM_CAP;
      else process.env.LUCID_STREAM_CAP = previous;
    }
  });
});
