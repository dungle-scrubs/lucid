import { EventKind } from "../protocol/events.js";
import type { HarnessRunner, StreamTurnOptions } from "./runner.js";

export class IsolatedTextError extends Error {
  readonly code = "isolated-text-failed";
}

/** Derived work cannot resume a working session or execute a tool. Its
 * caller owns the isolated directory and validation of the returned text. */
export async function runIsolatedText(
  runner: HarnessRunner,
  options: Omit<StreamTurnOptions, "resume" | "isolation">,
  maxChars: number,
): Promise<string> {
  let tokens = "";
  let message = "";
  let completed = false;
  for await (const event of runner.streamTurn({
    ...options,
    isolation: "tool-free",
    resume: undefined,
  })) {
    if (
      event.kind === EventKind.failure ||
      event.kind === EventKind.error ||
      event.kind === EventKind.tool ||
      event.kind === EventKind.question
    )
      throw new IsolatedTextError("The isolated operation failed");
    if (event.kind === EventKind.token && typeof event.text === "string") tokens += event.text;
    if (
      event.kind === EventKind.message &&
      event.role === "assistant" &&
      typeof event.text === "string"
    )
      message = event.text;
    if (tokens.length > maxChars || message.length > maxChars)
      throw new IsolatedTextError("The isolated output exceeds its limit");
    if (event.kind === EventKind.done) completed = event.exitCode === 0 && event.cause === "clean";
  }
  const text = message || tokens;
  if (!completed || options.signal?.aborted)
    throw new IsolatedTextError("The isolated operation did not complete");
  return text;
}
