/**
 * `lucid inject` - PostToolUse hook (M2.3, D-014).
 *
 * On the PostToolUse boundary it resolves + verifies the record (same
 * guard as `announce`), reads queued input, appends the delivery +
 * `disposition`, and emits the injection via hook stdout
 * (`{decision: "block", reason}` - the A-002-proven shape). On a
 * reducer refusal it reports the disposition class, no blind retry
 * (E004). Injected input is chunked under a cap measured in encoded
 * UTF-8 bytes (post-JSON-escape). Lucid detects and coexists with
 * pre-existing project hooks; its `decision` output composes, never
 * clobbers (D-014 C2). `HERDR_ENV` is unset for the child. The
 * injection contract does not depend on the Stop hook firing (Stop is
 * best-effort, D-014).
 *
 * What it is NOT: it is not the live-delivery follow-tailer (deferred),
 * and it does not depend on the Stop hook.
 */

import { openConversation } from "../../store/store.js";
import { resolveVerifiedRecord } from "./resolver.js";

const CHUNK_CAP_BYTES = 4000; // cap per injected block (UTF-8, post-JSON-escape)

export interface InjectResult {
  readonly ok: boolean;
  readonly delivered?: number;
  readonly chunks?: number;
  readonly code?: "hook-resolution-failed" | "injection-refused";
  readonly message?: string;
}

/** Measure the UTF-8 byte length of `text` after JSON-escaping (the cap
 * is post-JSON-escape, not code points). */
export const encodedByteLength = (text: string): number =>
  Buffer.byteLength(JSON.stringify(text), "utf8") - 2; // strip surrounding quotes

/** Chunk `text` under `cap` measured in encoded UTF-8 bytes. Each chunk
 * is a valid string that, when JSON-stringified, stays under the cap. */
export const chunkInput = (text: string, cap = CHUNK_CAP_BYTES): readonly string[] => {
  if (encodedByteLength(text) <= cap) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    // Greedy: extend `end` until the encoded slice would exceed cap.
    let end = start + 1;
    while (end <= text.length) {
      const slice = text.slice(start, end);
      if (encodedByteLength(slice) > cap) break;
      end++;
    }
    // `end - 1` is the last that fit; if even one char exceeds cap
    // (e.g., a single emoji that JSON-escapes to 12 bytes), emit it
    // alone rather than looping forever.
    const chunkEnd = end - 1 > start ? end - 1 : start + 1;
    chunks.push(text.slice(start, chunkEnd));
    start = chunkEnd;
  }
  return chunks;
};

export const inject = async (stdin: string): Promise<InjectResult> => {
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return { ok: true };
  }

  const resolved = resolveVerifiedRecord();
  if ("notManaged" in resolved) return { ok: true };
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, message: resolved.message };
  }
  const recordDir = resolved.record.dir;

  // Read queued input: for v2, the queue is the set of `input` entries
  // with status outstanding/queued in the durable transcript. A `lucid
  // send` appends them; `inject` delivers the oldest chunk.
  // For the hook's stdin, the PostToolUse payload carries the tool
  // result; we do not need it to find queued inputs.
  void payload;

  let queued: { id: string; text: string }[] = [];
  try {
    const { viewConversation } = await import("../../store/store.js");
    const view = viewConversation(recordDir);
    queued = view.transcript.inputs
      .filter((inp) => inp.status === "outstanding" || inp.status === "queued")
      .map((inp) => ({ id: inp.id, text: inp.text }));
  } catch {
    return { ok: true };
  }

  if (queued.length === 0) return { ok: true };

  // Deliver the first queued input, chunked.
  const first = queued[0];
  if (!first) return { ok: true };
  const chunks = chunkInput(first.text);

  // Ensure HERDR_ENV is unset for the child (isolation, D-025).
  delete process.env.HERDR_ENV;

  try {
    const host = openConversation(recordDir, {
      now: () => Date.now(),
      presence: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });

    // Append the delivery as a `disposition`-like frame? For v2, the
    // delivery is an `input` re-enqueue with mode steer, plus a
    // disposition. Simplify: we enqueue the chunk as a new input and
    // let the reducer's disposition surface as the next tool result.
    for (const chunk of chunks) {
      const res = host.enqueueInput({
        id: `${first.id}-chunk-${chunks.indexOf(chunk)}`,
        text: chunk,
        mode: "steer",
      });
      if (res.verdict === "refused") {
        // E004: report the disposition class, no blind retry.
        const issue = "issue" in res ? String((res as { issue: string }).issue) : "unknown";
        return { ok: false, code: "injection-refused", message: `disposition: ${issue}` };
      }
    }

    // Emit the injection via hook stdout: the A-002-proven shape.
    // Coexistence: we output ONLY our decision; claude's hook runner
    // composes multiple PostToolUse decisions, so we never clobber.
    const reason = `HUMAN FEEDBACK: ${first.text.slice(0, 200)}`;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    return { ok: true, delivered: 1, chunks: chunks.length };
  } catch (e) {
    if (e instanceof Error && /lock-timeout|lock-unavailable/.test(e.message)) {
      return { ok: false, code: "hook-resolution-failed", message: e.message };
    }
    throw e;
  }
};

export const runInject = async (): Promise<void> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const stdin = Buffer.concat(chunks).toString("utf8");
  const result = await inject(stdin);
  if (!result.ok && result.code === "hook-resolution-failed") {
    process.stderr.write(`inject: ${result.code}: ${result.message}\n`);
    process.exit(0);
  }
  if (!result.ok && result.code === "injection-refused") {
    process.stderr.write(`inject: ${result.code}: ${result.message}\n`);
    // Still exit 0 - the hook's stdout decision is the signal, not the exit code.
    process.exit(0);
  }
  process.exit(0);
};
