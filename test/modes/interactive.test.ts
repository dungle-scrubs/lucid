import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCode } from "@dungle-scrubs/harness-cli/src/knowledge/claude-code.js";
import {
  A003_GATE_OPEN,
  attachCapabilities,
  chunkInjection,
  INJECTION_CAP,
  parseAnnounce,
  selectRung,
  tailTranscript,
} from "../../src/modes/interactive.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { attach } from "../protocol/helpers.js";

const transcriptPath = fileURLToPath(
  new URL("../../spikes/evidence/a002-transcript.jsonl", import.meta.url),
);
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
    expect(chunkInjection("short")).toEqual(["short"]);
    // An empty message still delivers one chunk so its disposition is real.
    expect(chunkInjection("")).toEqual([""]);

    const long = "x".repeat(INJECTION_CAP * 2 + 37);
    const chunks = chunkInjection(long);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(INJECTION_CAP);
    expect(chunks.join("")).toBe(long);

    // A tiny cap exercises the boundary; reassembly is lossless.
    const c2 = chunkInjection("abcdef", 2);
    expect(c2).toEqual(["ab", "cd", "ef"]);
    expect(() => chunkInjection("x", 0)).toThrow();
  });

  test("capabilities query is runtime-verified for a curated model and degrades to unknown otherwise (D-008)", () => {
    const known = attachCapabilities(claudeCode, "sonnet", "interactive");
    expect(known.source).toBe("curated");
    expect(known.confidence).not.toBe("none");

    const unknown = attachCapabilities(claudeCode, "some-unreleased-model", "interactive");
    expect(unknown.source).toBe("unknown");
    expect(unknown.confidence).toBe("none");
    expect(unknown.streaming).toBe("none");
  });

  test("transcript tail emits assistant messages and resumes by byte offset without dupes after an adapter restart", () => {
    const raw = readFileSync(transcriptPath, "utf8");

    // First poll from the start reads the whole transcript.
    const first = tailTranscript(raw, 0);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.every((e) => e.kind === "message")).toBe(true);
    expect(first.offset).toBe(raw.length);

    // Adapter restarts and resumes from the recorded offset: nothing new,
    // no re-emission of what it already saw.
    const resumed = tailTranscript(raw, first.offset);
    expect(resumed.events).toEqual([]);
    expect(resumed.offset).toBe(raw.length);

    // Split the poll mid-stream: the union of two partial polls equals one
    // full poll - no message dropped or duplicated across the seam.
    const midNl = raw.indexOf("\n", Math.floor(raw.length / 2)) + 1;
    const partA = tailTranscript(raw, 0 + 0); // fresh
    void partA;
    const upto = tailTranscript(raw.slice(0, midNl), 0);
    const rest = tailTranscript(raw, upto.offset);
    expect(upto.events.length + rest.events.length).toBe(first.events.length);
  });

  test("a torn trailing transcript line is left unconsumed so the next poll re-reads it whole", () => {
    const raw = readFileSync(transcriptPath, "utf8");
    const lastNl = raw.lastIndexOf("\n");
    // Chop the final newline: the last line is now torn (mid-append).
    const torn = raw.slice(0, lastNl);
    const withoutTail = torn.slice(0, torn.lastIndexOf("\n") + 1);

    const result = tailTranscript(torn, 0);
    // The offset stops at the last COMPLETE line, not the torn fragment.
    expect(result.offset).toBe(withoutTail.length);
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
