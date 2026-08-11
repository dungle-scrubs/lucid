import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame } from "../../src/protocol/index.js";
import {
  createConversationRecord,
  openConversation,
  viewConversation,
} from "../../src/store/store.js";
import { attach } from "../protocol/helpers.js";

const freshRoot = (): string => mkdtempSync(join(tmpdir(), "lucid-m13-"));

const waitForChild = (child: ReturnType<typeof spawn>, label: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${label} exited ${code}: out=${out} err=${err}`));
      else resolve();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

describe("two-writer real-flock integration (M1.3)", () => {
  test("two real processes append concurrently under flock: no torn lines, strictly increasing seq, no collision, reopened fold matches union", async () => {
    const root = freshRoot();
    const { secret, paths } = createConversationRecord(root, "conv-1");
    const dir = join(root, "conv-1");

    // Establish the conversation with one attach so epoch is 1
    {
      const host = openConversation(dir, {
        now: () => 1_000,
        presence: () => undefined,
        onEffect: () => {},
        onRecord: () => {},
      });
      const res = host.handleFrame(encodeFrame(attach({ secret, conversationId: "conv-1" })));
      if (res.verdict !== "accepted") {
        throw new Error(`initial attach refused: ${JSON.stringify(res)}`);
      }
      expect(res.verdict).toBe("accepted");
    }

    const writerScript = join(import.meta.dir, "m13-writer-child.ts");

    // Spawn two writers concurrently
    const a = spawn(process.execPath, [writerScript, dir, "A", "20"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const b = spawn(process.execPath, [writerScript, dir, "B", "20"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    await Promise.all([waitForChild(a, "writer-A"), waitForChild(b, "writer-B")]);

    // 1. No torn lines: every line is valid JSON and ends with newline
    const raw = readFileSync(paths.logPath);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[raw.length - 1]).toBe(0x0a); // ends with NL
    const text = raw.toString("utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(1 + 20 + 20); // attach + 40 inputs
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed.v).toBe(1);
    }

    // 2. Seqs are strictly increasing with no collision (via viewConversation)
    const view = viewConversation(dir);
    const seqs = view.transcript.inputs.map((inp) => inp.seq);
    // All inputs should have seqs, and they should be strictly increasing
    expect(seqs.length).toBe(40);
    for (let i = 1; i < seqs.length; i++) {
      const cur = seqs[i];
      const prev = seqs[i - 1];
      if (cur === undefined || prev === undefined) throw new Error("missing seq");
      expect(cur).toBeGreaterThan(prev);
    }
    // No seq collision: set size == array length
    expect(new Set(seqs).size).toBe(seqs.length);

    // 3. Epoch/seq no collision: all inputs share same epoch (1) but distinct seq
    // (epoch is stored in ChannelState, inputs' seq are global)
    const reopened = openConversation(dir, {
      now: () => 10_000,
      presence: () => undefined,
      onEffect: () => {},
      onRecord: () => {},
    });
    expect(reopened.state().seq).toBe(view.state.seq);
    expect(reopened.state().epoch).toBe(view.state.epoch);

    // 4. Reopened fold matches union of both writers' entries
    const reopenedView = viewConversation(dir);
    expect(reopenedView.transcript.inputs.length).toBe(40);
    // Union check: every writer id is present exactly once
    const ids = new Set(reopenedView.transcript.inputs.map((i) => i.id));
    expect(ids.size).toBe(40);
    for (const inp of reopenedView.transcript.inputs) {
      expect(inp.id.startsWith("A-") || inp.id.startsWith("B-")).toBe(true);
    }

    rmSync(root, { recursive: true, force: true });
  }, 20_000);
});
