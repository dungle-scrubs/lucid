/** Serializable completion evidence shared by the harness seam and durable protocol. */
export type InteractiveResult =
  | {
      readonly evidence: "spawn-not-attempted" | "dispatch-not-called";
      readonly kind: "refused";
      readonly reason: string;
    }
  | { readonly cleanupComplete: true; readonly exitCode: number | null; readonly kind: "closed" }
  | { readonly kind: "uncertain"; readonly reason: string };

// Unknown HCN reason codes cannot prove that native creation was prevented.
const REFUSAL_REASONS = new Set([
  "unsupported-interface",
  "resume-unavailable",
  "cwd-refused",
  "invalid-request",
  "executable-unavailable",
  "spawn-rejected",
]);

export function isInteractiveRefusalReason(value: unknown): value is string {
  return typeof value === "string" && REFUSAL_REASONS.has(value);
}
