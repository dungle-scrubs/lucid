import type { NativeContinuationSettings, NativeContinuationTarget } from "./runner.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads only HCN's public settings projection, never native files or configuration. */
export function nativeContinuationSettings(
  value: unknown,
  code: number | null,
  target: NativeContinuationTarget,
): NativeContinuationSettings {
  const raw = record(value);
  const unavailable = (reason: string): NativeContinuationSettings => ({
    status: "unavailable",
    reason,
  });
  if (raw?.v !== 1 || raw.harness !== target.harness) return unavailable("invalid-native-settings");
  if (raw.status === "unavailable" && code === 2)
    return unavailable(
      typeof raw.reason === "string" && /^[a-z-]{1,128}$/.test(raw.reason)
        ? raw.reason
        : "native-settings-unavailable",
    );
  if (
    code !== 0 ||
    raw.status !== "available" ||
    raw.sessionId !== target.resume ||
    raw.cwd !== target.cwd
  )
    return unavailable("invalid-native-settings");
  const { effort, fingerprint, model, provider } = raw;
  if (
    typeof effort !== "string" ||
    effort.length === 0 ||
    typeof fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    typeof model !== "string" ||
    model.length === 0 ||
    typeof provider !== "string" ||
    provider.length === 0
  )
    return unavailable("invalid-native-settings");
  const permissions = record(raw.permissions);
  if (
    permissions?.status !== "recorded" ||
    permissions.approvalsReviewer !== "user" ||
    (permissions.approvalPolicy !== "on-request" && permissions.approvalPolicy !== "never") ||
    permissions.filesystem !== "read-only" ||
    permissions.network !== "restricted"
  )
    return unavailable("native-permissions-unverified");
  return { effort, fingerprint, model, provider, status: "available" };
}
