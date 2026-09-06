import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import {
  A003_GATE_OPEN,
  chunkHookInput,
  deliverFirstQueued,
  HOOK_CHUNK_CAP_BYTES,
  parseAnnounce,
  selectRung,
} from "../../src/modes/interactive-host.js";
import { openWriter } from "../../src/store/conversation-host.js";
import { Flock, LockError } from "../../src/store/flock.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";
import { attach } from "../protocol/helpers.js";

const announcePath = fileURLToPath(
  new URL("../../spikes/evidence/a002-announce.log", import.meta.url),
);

describe("interactive adapter ladder - rung 1 logic (M5.3)", () => {
  test("rung degradation is strict order: hooks when isolated, else observe-only while the A-003 gate is closed (rungs 2-3 deferred)", () => {
    // Isolation present (D-025): the hooks rung is reachable.
    expect(selectRung({ hooksIsolated: true, cooperativeAvailable: true })).toMatchObject({
      rung: "hooks",
      inject: "boundary",
      attach: "lucid-aware",
    });

    // No isolation: the cooperative rung is GATED (A-003 deferred), so the
    // ladder falls straight to observe-only - never a rung it cannot honor.
    expect(A003_GATE_OPEN).toBe(false);
    expect(selectRung({ hooksIsolated: false, cooperativeAvailable: true })).toMatchObject({
      rung: "observe",
      inject: "resume-instruction",
      attach: "none",
    });

    // observe always works - selection never fails even with nothing.
    expect(selectRung({ hooksIsolated: false, cooperativeAvailable: false }).rung).toBe("observe");
  });

  test("injection chunking holds every chunk at or under the cap and preserves the message exactly", () => {
    expect(chunkHookInput("short")).toEqual(["short"]);
    // An empty message still delivers one chunk so its disposition is real.
    expect(chunkHookInput("")).toEqual([""]);

    const long = "x".repeat(HOOK_CHUNK_CAP_BYTES * 2 + 37);
    const chunks = chunkHookInput(long);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(HOOK_CHUNK_CAP_BYTES);
    expect(chunks.join("")).toBe(long);

    // A tiny cap exercises the boundary; reassembly is lossless.
    const c2 = chunkHookInput("abcdef", 2);
    expect(c2).toEqual(["ab", "cd", "ef"]);
    expect(() => chunkHookInput("x", 0)).toThrow();
    expect(() => chunkHookInput("x", 1.5)).toThrow();

    // Astral chars are never split across chunks: each chunk is
    // independently well-formed UTF-8 (no lone surrogate -> no U+FFFD).
    const emoji = chunkHookInput("a\u{1F600}b\u{1F601}c", 2);
    for (const c of emoji) expect(Buffer.from(c, "utf8").toString("utf8")).toBe(c);
    expect(emoji.join("")).toBe("a\u{1F600}b\u{1F601}c");
  });

  test("capabilities query is answered by hcn, curated for a known model and unknown otherwise (D-008)", async () => {
    // The capability answer is hcn's, read at runtime - not a descriptor
    // lucid holds a copy of. That is what makes it runtime-verified.
    const ask = async (payload: unknown) => {
      const proc = new FakeHcnProcess();
      const spawner = fakeSpawner([proc]);
      const runner = createHcnRunner({ spawn: spawner.spawn, bin: "/fake/hcn" });
      const pending = runner.capabilities("claude", "sonnet", "interactive");
      proc.emitRaw(JSON.stringify(payload));
      proc.exit(0);
      return { result: await pending, argv: spawner.calls[0]?.argv ?? [] };
    };

    const known = await ask({
      vision: true,
      images: true,
      streaming: "token",
      session: true,
      source: "curated",
      confidence: "medium",
    });
    expect(known.result.source).toBe("curated");
    expect(known.result.confidence).not.toBe("none");
    // The mode reaches hcn: an interactive capability is not a headless one.
    expect(known.argv).toContain("interactive");

    const unknown = await ask({
      vision: false,
      images: false,
      streaming: "none",
      session: false,
      source: "unknown",
      confidence: "none",
    });
    expect(unknown.result.source).toBe("unknown");
    expect(unknown.result.confidence).toBe("none");
    expect(unknown.result.streaming).toBe("none");
  });

  test("SessionStart announce parses into lucid's attach intent - identity + transcript path, with zero agent cooperation (A-002)", () => {
    const line = readFileSync(announcePath, "utf8").trim().split("\n")[0] ?? "";
    const announce = parseAnnounce(line);
    expect(announce).not.toBeNull();
    expect(announce?.sessionId).toBe("ac0654bc-609b-4f19-88f0-75e2e95aff2a");
    expect(announce?.transcriptPath).toContain(".jsonl");
    expect(announce?.source).toBe("startup");

    // A non-SessionStart hook line, or malformed JSON, is not an attach.
    expect(parseAnnounce('{"hook":"PostToolUse","session_id":"x"}')).toBeNull();
    expect(parseAnnounce("not json")).toBeNull();
    expect(parseAnnounce('{"hook":"SessionStart","session_id":""}')).toBeNull();
  });

  test("forbidden path: a headless resume while presence holds is refused by the host - the adapter never appends behind a live human", () => {
    // A live interactive process holds the conversation (presence
    // corroborates it alive); the interactive channel's lease then lapses.
    const root = mkdtempSync(join(tmpdir(), "lucid-ladder-"));
    const { secret } = createConversationRecord(root, "conv-1");
    const clock = { t: 1_000 };
    const host = openConversation(join(root, "conv-1"), {
      now: () => clock.t,
      presence: () => true, // the human's process is alive
      executorLease: () => false,
      onRecord: () => {},
      onEffect: () => {},
    });
    host.handleFrame(
      JSON.stringify(attach({ conversationId: "conv-1", secret, profile: "interactive" })),
    );
    clock.t = 1_000 + 20_000; // lease expired, but presence still holds

    // A headless resume contender attaches: the host refuses presence-holds
    // (D-018/D-021) - the harness would otherwise append with no guard.
    const forbidden = host.handleFrame(
      JSON.stringify(attach({ conversationId: "conv-1", secret, profile: "headless-session" })),
    );
    expect(forbidden.verdict).toBe("refused");
    expect("issue" in forbidden && forbidden.issue).toBe("presence-holds");
    // The live interactive writer still holds epoch 1: nothing was stolen.
    expect(host.state().epoch).toBe(1);
  });
});

test.each(["lock-timeout", "lock-unavailable"] as const)(
  "hook delivery reports a typed %s without matching error prose",
  (code) => {
    const root = mkdtempSync(join(tmpdir(), "lucid-hook-lock-"));
    createConversationRecord(root, "hook-lock");
    const dir = join(root, "hook-lock");
    const host = openWriter(dir);
    host.enqueueInput({ id: "queued", text: "feedback", mode: "queue" });
    host.close();
    const failingLock = spyOn(Flock.prototype, "acquire").mockImplementation(() => {
      throw new LockError(code, "test-lock", "synthetic failure with no code in its message");
    });
    try {
      expect(deliverFirstQueued(dir)).toMatchObject({ ok: false, code: "hook-resolution-failed" });
    } finally {
      failingLock.mockRestore();
    }
  },
);
