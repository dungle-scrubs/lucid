import { closeSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { LogError } from "../errors.ts";
import { hasId, type EventInput, type LogEvent } from "./events.ts";
import { withAppendLock } from "./lock.ts";

export interface ReadResult {
  readonly events: readonly LogEvent[];
  /** True if the file ended with an incomplete (non-newline-terminated) line. */
  readonly tornTail: boolean;
}

/**
 * Read and parse the event log, tolerating a torn trailing line (crash mid-
 * append) per D-030. A parse failure on a *committed* (newline-terminated)
 * line is a `LogError`; an incomplete final line is silently ignored.
 */
export const readEvents = async (logPath: string): Promise<ReadResult> => {
  let content: string;
  try {
    content = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], tornTail: false };
    }
    throw new LogError({ message: `cannot read log: ${(err as Error).message}` });
  }

  if (content.length === 0) return { events: [], tornTail: false };

  const endsWithNewline = content.endsWith("\n");
  const parts = content.split("\n");
  // Drop the trailing element: an empty string if newline-terminated, otherwise
  // the torn final line.
  const tornTailContent = parts.pop();
  const tornTail = !endsWithNewline && (tornTailContent ?? "").length > 0;

  const events: LogEvent[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line === undefined || line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch {
      throw new LogError({
        message: `corrupt committed log line ${i + 1}`,
        detail: { line: i + 1, content: line.slice(0, 200) },
      });
    }
  }
  return { events, tornTail };
};

/** Highest `seq` among events, or 0 for an empty log. */
export const maxSeq = (events: readonly LogEvent[]): number =>
  events.reduce((m, e) => (e.seq > m ? e.seq : m), 0);

/** Set of all client/CLI-minted ids present in the log (for dedupe; D-057). */
export const collectIds = (events: readonly LogEvent[]): Set<string> => {
  const ids = new Set<string>();
  for (const e of events) if (hasId(e)) ids.add(e.id);
  return ids;
};

const inputId = (input: EventInput): string | undefined =>
  "id" in input ? (input as { id: string }).id : undefined;

/** Synchronous, fsync'd append of a payload string to the log fd. */
const appendDurable = (logPath: string, payload: string): void => {
  const fd = openSync(logPath, "a");
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * Truncate a torn (non-newline-terminated) trailing line in-place, leaving the
 * file ending at the last newline. Called inside the append lock before writing
 * so that an append following a crash-mid-append does not concatenate onto the
 * partial line and corrupt the log (D-030).
 */
const truncateTornTail = (logPath: string): void => {
  let data: Buffer;
  try {
    data = readFileSync(logPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (data.length === 0 || data[data.length - 1] === 0x0a /* \n */) return;
  const lastNewline = data.lastIndexOf(0x0a);
  const cut = lastNewline === -1 ? 0 : lastNewline + 1;
  truncateSync(logPath, cut);
};

/**
 * Append events under the exclusive log lock (D-049). Re-reads inside the lock
 * to assign globally-monotonic `seq` (D-050) and to dedupe identified events
 * against the ids already in the log (D-057). A torn trailing line from a prior
 * crash-mid-append is truncated before writing so the new append never
 * concatenates onto a partial line (D-030). Returns the resulting events in
 * input order - newly appended events with their assigned `seq`/`at`, and for a
 * deduped input the pre-existing event already in the log.
 */
export const appendEvents = async (
  logPath: string,
  inputs: readonly EventInput[],
): Promise<readonly LogEvent[]> => appendEventsIf(logPath, () => true, inputs);

/** Convenience single-event append. */
export const appendEvent = async (logPath: string, input: EventInput): Promise<LogEvent> => {
  const [ev] = await appendEvents(logPath, [input]);
  if (ev === undefined) {
    throw new LogError({ message: "append produced no event" });
  }
  return ev;
};

/**
 * Atomically check-then-append under the exclusive log lock (D-049). Runs
 * `guard` (re-reading the log inside the lock) and only commits `inputs` if the
 * guard returns true. This closes the TOCTOU where a status check outside the
 * lock could let an event land in a just-closed segment. Returns the appended
 * events (empty if the guard rejected) in input order, with dedupe applied.
 */
export const appendEventsIf = async (
  logPath: string,
  guard: (events: readonly LogEvent[]) => boolean | Promise<boolean>,
  inputs: readonly EventInput[],
): Promise<readonly LogEvent[]> => {
  if (inputs.length === 0) return [];
  return withAppendLock(logPath, async () => {
    const { tornTail, events } = await readEvents(logPath);
    if (tornTail) truncateTornTail(logPath);
    if (!(await guard(events))) return [];
    const existingIds = collectIds(events);
    let seq = maxSeq(events);
    const at = new Date().toISOString();
    const toWrite: LogEvent[] = [];
    const result: LogEvent[] = [];
    for (const input of inputs) {
      const id = inputId(input);
      if (id !== undefined && existingIds.has(id)) {
        const existing = events.find((e) => hasId(e) && e.id === id);
        if (existing) result.push(existing);
        continue;
      }
      seq += 1;
      const ev = { ...input, seq, at } as LogEvent;
      toWrite.push(ev);
      result.push(ev);
      if (id !== undefined) existingIds.add(id);
    }
    if (toWrite.length > 0) {
      const payload = `${toWrite.map((e) => JSON.stringify(e)).join("\n")}\n`;
      appendDurable(logPath, payload);
    }
    return result;
  });
};
