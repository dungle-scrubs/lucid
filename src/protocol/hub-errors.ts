import { type CompatibilityDiagnostic, CompatibilityError } from "./compatibility.js";

export class HubError extends CompatibilityError {
  constructor(
    message: string,
    readonly code: "E-HUB-01" | "E-HUB-02" | "E-HUB-03" | "E-HUB-04" | "E-HUB-08",
    readonly status = 400,
    readonly actions: readonly string[] = ["Review settings"],
    diagnostic?: CompatibilityDiagnostic,
  ) {
    super(message, diagnostic);
  }
}
