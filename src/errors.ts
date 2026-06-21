import { Data } from "effect";

/**
 * Typed errors modeled in Effect's error channel. Each carries a stable `code`
 * that is emitted as structured JSON on stdout with exit code 1 (see the CLI
 * error-handling boundary). Codes mirror the RFC Error Handling table.
 */

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}> {
  readonly code = "VALIDATION_ERROR" as const;
}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}> {
  readonly code = "NOT_FOUND" as const;
}

export class ArtifactError extends Data.TaggedError("ArtifactError")<{
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}> {
  readonly code = "ARTIFACT_ERROR" as const;
}

export class ServerError extends Data.TaggedError("ServerError")<{
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}> {
  readonly code = "SERVER_ERROR" as const;
}

export class LogError extends Data.TaggedError("LogError")<{
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}> {
  readonly code = "LOG_ERROR" as const;
}

export type LucidError = ValidationError | NotFoundError | ArtifactError | ServerError | LogError;

export interface ErrorJson {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: Readonly<Record<string, unknown>>;
  };
}

/** Render a typed error to the structured JSON envelope emitted on stdout. */
export const toErrorJson = (error: LucidError): ErrorJson => ({
  error: {
    code: error.code,
    message: error.message,
    detail: error.detail ?? {},
  },
});

/**
 * A non-fatal warning. Warnings never abort an operation; they are surfaced in
 * the wait payload and structured logs so the agent learns of degraded state
 * (missing snapshots, denied assets, failed structural validation, etc.).
 */
export interface Warning {
  readonly code:
    | "SNAPSHOT_MISSING"
    | "SNAPSHOT_MISMATCH"
    | "STRUCTURE_INVALID"
    | "LUCID_ID_DUPLICATE"
    | "VERSION_STAMP_INVALID"
    | "ASSET_DENIED"
    | "ASSET_NOT_FOUND";
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}
