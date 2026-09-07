export class HubError extends Error {
  constructor(
    message: string,
    readonly code: "E-HUB-01" | "E-HUB-02" | "E-HUB-03" | "E-HUB-04",
    readonly status = 400,
    readonly actions: readonly string[] = ["Review settings"],
  ) {
    super(message);
  }
}
