import type { RegistrationAuthority } from "../store/native-registration.js";
import { nativeRegistrationAuthority } from "../store/native-registration.js";
import { HEADLESS_NATIVE_ROLE, NATIVE_ROLE_ENV } from "./invocation.js";

export interface NativeCommandContext {
  readonly codexSessionId: string | undefined;
  readonly codexThreadId: string | undefined;
  readonly role: string | undefined;
}

// Codex core/src/exec_env.rs injects the current tool thread separately from its root session.
// Native parent/subagent acceptance confirms that only the parent has both IDs equal.
export function nativeCommandAuthority(
  context: NativeCommandContext = {
    codexSessionId: process.env.CODEX_SESSION_ID,
    codexThreadId: process.env.CODEX_THREAD_ID,
    role: process.env[NATIVE_ROLE_ENV],
  },
): RegistrationAuthority {
  return nativeRegistrationAuthority((capture) => {
    if (context.role !== undefined)
      return context.role === HEADLESS_NATIVE_ROLE ? false : undefined;
    if (capture.interface !== "codex-cli" || capture.harness !== "codex") return undefined;
    if (!context.codexSessionId || !context.codexThreadId) return undefined;
    return (
      context.codexSessionId === capture.nativeSessionId &&
      context.codexThreadId === capture.nativeSessionId
    );
  });
}
