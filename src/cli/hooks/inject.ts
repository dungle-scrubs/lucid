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

import { deliverFirstQueued, exitHook, guardHookEntry, readStdin } from "./delivery.js";

// Re-export the deep seam so existing importers keep their path. The
// single metric/cap lives in delivery.ts.
export {
  CHUNK_CAP_BYTES,
  chunkHookInput as chunkInput,
  encodedByteLength,
  HOOK_CHUNK_CAP_BYTES,
} from "./delivery.js";

export interface InjectResult {
  readonly ok: boolean;
  readonly delivered?: number;
  readonly chunks?: number;
  readonly code?: "hook-resolution-failed" | "injection-refused";
  readonly message?: string;
}

export const inject = async (stdin: string): Promise<InjectResult> => {
  const guard = guardHookEntry(stdin);
  if (!guard.proceed) return guard.result as InjectResult;
  return deliverFirstQueued(guard.record.dir);
};

export const runInject = async (): Promise<void> => {
  const stdin = await readStdin();
  const result = await inject(stdin);
  exitHook(result);
};
