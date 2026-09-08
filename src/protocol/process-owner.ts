/** A process identity claim. The host must corroborate it before recording ownership. */
export interface ProcessOwner {
  readonly executable: string;
  readonly pid: number;
  readonly startedAt: string;
}

export function parseProcessOwner(value: unknown): ProcessOwner | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fields = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(fields.pid) ||
    typeof fields.pid !== "number" ||
    fields.pid <= 0 ||
    typeof fields.startedAt !== "string" ||
    !fields.startedAt ||
    fields.startedAt.length > 128 ||
    typeof fields.executable !== "string" ||
    !fields.executable ||
    fields.executable.length > 4096 ||
    /\p{Cc}/u.test(fields.startedAt + fields.executable)
  )
    return undefined;
  return { executable: fields.executable, pid: fields.pid, startedAt: fields.startedAt };
}
