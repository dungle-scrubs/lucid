import type { NativeListenerDeps, NativeListenerResult } from "../modes/native-listener.js";
import { listenNativeFeedback } from "../modes/native-listener.js";
import { withNativeRegistration } from "../store/native-registration.js";
import { nativeCommandAuthority } from "./native-context.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir } from "./record-addressing.js";

interface CodexListenOptions {
  readonly output: "json" | "text" | "hook";
  readonly signal: AbortSignal;
  readonly source: "explicit" | "continuation";
}

// Stop continuations retain Codex's default spill limit. Native acceptance established
// complete delivery at 7,948 bytes; cap the entire encoded response below that bound.
const CODEX_FEEDBACK_BYTES = 7_900;

export async function listenCodexFeedback(
  records: Conversations,
  conversationId: string,
  options: CodexListenOptions,
  overrides: Partial<NativeListenerDeps> = {},
): Promise<NativeListenerResult> {
  const recordDir = commandRecordDir(records, conversationId);
  const authority = overrides.authority ?? nativeCommandAuthority();
  const verified = withNativeRegistration(
    records.rootDir,
    undefined,
    (registration) => registration.interface,
    authority,
  );
  if (!verified.ok) return { kind: "held", message: verified.message, reason: verified.reason };
  if (verified.value !== "codex-cli")
    return {
      kind: "held",
      message: "This native interface has no verified feedback transport. Feedback remains saved.",
      reason: "transport-unverified",
    };
  return listenNativeFeedback(
    {
      recordDir,
      root: records.rootDir,
      signal: options.signal,
      source: options.source,
      transport: {
        encode: (prompt) =>
          options.output === "hook"
            ? JSON.stringify({ decision: "block", reason: prompt })
            : options.output === "json"
              ? JSON.stringify({ kind: "offered", text: prompt })
              : prompt,
        maxBytes: CODEX_FEEDBACK_BYTES,
      },
    },
    { ...overrides, authority },
  );
}
