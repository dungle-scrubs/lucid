import type { NativeListenerDeps, NativeListenerResult } from "../modes/native-listener.js";
import { heldNativeFeedback, listenNativeFeedback } from "../modes/native-listener.js";
import type { NativeFeedbackTransport } from "../modes/native-preparation.js";
import { terminalPresence } from "../process-owner.js";
import type { NativeInterface } from "../protocol/connection.js";
import {
  currentReconnect,
  hasUnsettledNativeExecution,
  nativeOwners,
  reconnectForListener,
  sameNativeHistory,
  sameNativeTarget,
} from "../protocol/connection.js";
import { sameProcessOwner } from "../protocol/process-owner.js";
import { viewConversation } from "../store/conversation-host.js";
import type { NativeListenRequest, RegistrationAuthority } from "../store/native-registration.js";
import { withNativeRegistration } from "../store/native-registration.js";
import { presenceHeld } from "../store/presence.js";
import { nativeCommandAuthority } from "./native-context.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir } from "./record-addressing.js";

interface NativeListenOptions {
  readonly request: NativeListenRequest;
  readonly signal: AbortSignal;
  readonly source: "explicit" | "continuation";
}

// Stop continuations retain Codex's default spill limit. Native acceptance established
// complete delivery at 7,948 bytes; cap the entire encoded response below that bound.
const CODEX_FEEDBACK_BYTES = 7_900;
// Claude Code 2.1.274 delivered a 20,030-character Stop block reason intact in the isolated
// native contract probe; cap the entire encoded response below that bound.
const CLAUDE_FEEDBACK_BYTES = 19_900;

// Claude Code 2.1.274 returned `lucid context` output intact at 29,085 characters and replaced
// it with a preview at 29,771 (artifacts/evidence/claude-cli-native/slice-probe.mjs). A byte
// slice never prints more characters than bytes, so 24,000 keeps a 5,000-character margin.
const CLAUDE_CONTEXT_SLICE = 24_000;
const CONTEXT_SLICE_MIN = 4_096;

/** Claude Code lowers its Bash output limit through BASH_MAX_OUTPUT_LENGTH; hooks inherit it. */
export function claudeContextSlice(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.BASH_MAX_OUTPUT_LENGTH;
  if (raw === undefined || raw === "") return CLAUDE_CONTEXT_SLICE;
  const limit = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(limit)) return undefined;
  const slice = Math.min(CLAUDE_CONTEXT_SLICE, Math.floor(limit * 0.8));
  return slice >= CONTEXT_SLICE_MIN ? slice : undefined;
}

/** Interfaces whose Stop continuation passed native acceptance. Others keep feedback saved. */
const STOP_TRANSPORTS: Partial<Record<NativeInterface, NativeFeedbackTransport>> = {
  "claude-cli": {
    contextSlice: claudeContextSlice(process.env),
    encode: (prompt) => JSON.stringify({ decision: "block", reason: prompt }),
    instructions:
      "Run each Lucid command in its own foreground Bash call. Lucid records receipt and response when that Bash call finishes and reports the result in the tool output.",
    maxBytes: CLAUDE_FEEDBACK_BYTES,
  },
  "codex-cli": {
    encode: (prompt) => JSON.stringify({ decision: "block", reason: prompt }),
    maxBytes: CODEX_FEEDBACK_BYTES,
  },
};
const UNVERIFIED_TRANSPORT = heldNativeFeedback(
  "transport-unverified",
  "This native interface has no verified feedback transport. Feedback remains saved.",
);

type ListenRequestResult =
  | { readonly conversationId: string; readonly kind: "requested"; readonly message: string }
  | Extract<NativeListenerResult, { kind: "held" }>;

/** Select a record for the next Stop. This command neither waits nor grants readiness. */
export function requestNativeListening(
  records: Conversations,
  conversationId: string,
  authority: RegistrationAuthority = nativeCommandAuthority(),
): ListenRequestResult {
  const dir = commandRecordDir(records, conversationId);
  const result = withNativeRegistration(
    records.rootDir,
    undefined,
    (registration, access): ListenRequestResult => {
      if (!STOP_TRANSPORTS[registration.interface]) return UNVERIFIED_TRANSPORT;
      const state = viewConversation(dir).state;
      const binding = state.connection?.binding;
      if (!sameNativeTarget(binding, registration))
        return heldNativeFeedback(
          "connection-conflict",
          "This conversation is not bound to the current native session. Its binding was kept.",
        );
      // This session-wide check runs only on explicit selection. Stop and Interrupt
      // read the selected record; their bounded callbacks never scan other histories.
      const listing = records.list();
      if (listing.errors.length > 0)
        return heldNativeFeedback(
          "connection-unverified",
          "Some conversation identities could not be verified. Resolve them before changing this session's listening request.",
        );
      for (const [candidateId, candidateDir] of listing.identities) {
        const candidate =
          candidateId === conversationId ? state : viewConversation(candidateDir).state;
        const candidateBinding = candidate.connection?.binding;
        // The same native history remains shared across interfaces and folder spellings.
        // Those differences cannot exempt another record from the session-wide fence.
        if (!sameNativeHistory(candidateBinding, registration)) continue;
        let otherOwners: boolean | undefined;
        try {
          otherOwners = terminalPresence(
            nativeOwners(candidate).filter(
              (entry) => !sameProcessOwner(entry.owner, registration.owner),
            ),
            (owner) => (owner ? authority.ownerPresence(owner) : undefined),
          );
        } catch {
          /* Failed process evidence stays unknown. */
        }
        if (otherOwners !== false)
          return heldNativeFeedback(
            otherOwners ? "connection-conflict" : "connection-unverified",
            "Another owner of this native session is open or could not be verified. Resolve ownership before listening.",
          );
        if (
          hasUnsettledNativeExecution(candidate) ||
          (currentReconnect(candidate.connection) &&
            !(
              candidateId === conversationId &&
              reconnectForListener(candidate.connection, registration)
            ))
        )
          return heldNativeFeedback(
            "execution-blocked",
            "A previous delivery or execution in this native session must settle before listening again.",
          );
        if (presenceHeld(candidateDir) !== false)
          return heldNativeFeedback(
            "executor-busy",
            "The current executor in this native session must finish before listening can be requested.",
          );
      }
      const saved = access.writeListenRequest({ actionId: crypto.randomUUID(), conversationId });
      return saved.ok
        ? {
            conversationId,
            kind: "requested",
            message:
              "Listening requested. Finish this native turn; the Stop hook will wait up to 45 seconds for saved feedback. Expiry or interruption requires another explicit resume-listen.",
          }
        : heldNativeFeedback(saved.reason, saved.message);
    },
    authority,
  );
  return result.ok ? result.value : heldNativeFeedback(result.reason, result.message);
}

export async function listenStopFeedback(
  records: Conversations,
  conversationId: string,
  options: NativeListenOptions,
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
  if (!verified.ok) return heldNativeFeedback(verified.reason, verified.message);
  const transport = STOP_TRANSPORTS[verified.value];
  if (!transport) return UNVERIFIED_TRANSPORT;
  return listenNativeFeedback(
    {
      recordDir,
      request: options.request,
      root: records.rootDir,
      signal: options.signal,
      source: options.source,
      transport,
    },
    { ...overrides, authority },
  );
}
