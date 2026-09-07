/**
 * The driver preference (RFC-12): `driver.json`, beside `meta.json`.
 *
 * What a person chose in the browser - the harness, its model, a provider
 * where the harness expresses one, an effort level. It is a standing
 * choice, rewritten at will, so it is a file and never a log entry: the log
 * is the append-only truth of what happened, and folding a preference into
 * it would either freeze the choice or litter the truth with supersessions.
 *
 * **Who writes it:** the server, on the browser's behalf. Nothing else. A
 * driver only reads - the driver in force is already in the log, on the
 * attach and identity events, and a driver rewriting the file to record
 * what it spawned under would be two writers where the design allows one.
 *
 * The write is an atomic replace, after the blob store's discipline: the
 * bytes go to a temporary name in the record directory and are renamed
 * over. A driver reads the file while the server may be replacing it, and
 * a rename gives every reader the whole old file or the whole new one,
 * never a torn one. The file is `0o600` like every file in the record, and
 * travels with it: a copied record carries the person's choice to wherever
 * it reopens.
 *
 * What it is NOT: it is not the log, not a frame, and not a claim about
 * what is running. The preference and the driver in force are different
 * things, and the projection reports them in different fields.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { HARNESS_NAMES, type HarnessName } from "../protocol/frames.js";
import { pathsForDir, StoreError } from "./errors.js";
import { validArtifactId } from "./log.js";
import { readRecordIdentity, withRecordLock } from "./record-identity.js";

/** How long a preference field may be, in UTF-16 code units. The record's
 * existing wire-id bound, stated here so the endpoint can echo it back. */
export const DRIVER_FIELD_MAX = 128;

/** The choice a person made: the harness, and the dimensions set on it.
 * What the endpoint accepts and the driver honors; absent fields mean the
 * corresponding hcn default applies at spawn. */
export interface DriverChoice {
  readonly harness: HarnessName;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** What the file holds: the choice under a version stamp, like `meta.json`
 * carries its `v: 1`. What the read returns and the projection reports -
 * RFC-12 says the page is told the file's content. */
export interface DriverPreference {
  readonly v: 1;
  readonly harness: HarnessName;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** One of the four names, as a guard. */
export const isDriverHarness = (v: unknown): v is HarnessName =>
  typeof v === "string" && (HARNESS_NAMES as readonly string[]).includes(v);

/** A preference field's shape: the record's existing wire-id rule, reached
 * through `validArtifactId` rather than restated, so the bound the fold
 * applies and the bound here cannot drift. A model id, a provider name and
 * an effort level are the same kind of thing an artifact field is - a short
 * control-free string that becomes a flag value, never prose. */
export const isDriverField = (v: unknown): v is string => validArtifactId(v);

/** The fields a preference body may carry (RFC-12): the version stamp, the
 * spine, and the three dimensions. Everything else is the endpoint's
 * `unknown-field` - `mode` and `profile` deliberately among them, because
 * mode is not settable from the browser. */
export const DRIVER_BODY_FIELDS: ReadonlySet<string> = new Set([
  "v",
  "harness",
  "provider",
  "model",
  "effort",
]);

/**
 * Read the record's driver preference, or null when there is none.
 *
 * Null is the honest answer for more than an absent file, because the file
 * is a preference and not a truth-source: a record whose `driver.json`
 * cannot be parsed still opens, still drives, and simply has no preference -
 * the same discipline that lets the fold carry an entry it does not know.
 * Unknown fields are ignored and read fields are read; a known field that
 * fails its shape is treated as unset rather than allowed to reach a spawn.
 * A file with no valid harness is no preference at all: the harness is the
 * spine the other fields are values in, and a value without its domain
 * names nothing.
 *
 * Never throws: the driver reads this at startup and at turn boundaries,
 * where a throw would cost a conversation for the sake of a sidecar.
 */
export const readDriverPreference = (dir: string): DriverPreference | null => {
  const path = pathsForDir(dir).driverPath;
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  const file = (parsed ?? {}) as Record<string, unknown>;
  if (!isDriverHarness(file.harness)) return null;
  return {
    v: 1,
    harness: file.harness,
    ...(isDriverField(file.provider) ? { provider: file.provider } : {}),
    ...(isDriverField(file.model) ? { model: file.model } : {}),
    ...(isDriverField(file.effort) ? { effort: file.effort } : {}),
  };
};

const writeAll = (fd: number, bytes: Buffer): void => {
  let written = 0;
  while (written < bytes.length) written += writeSync(fd, bytes, written);
};

/**
 * Replace the record's driver preference and return what the file now
 * holds.
 *
 * The whole preference, not a patch: a field left out is a field cleared,
 * back to the hcn default. Refuses a malformed preference before anything
 * is written - the shape is validated at the endpoint, and asserting it
 * here too means this module cannot be the second writer of a bad file.
 *
 * Writing is atomic: temporary name in the record directory, `0o600`,
 * fsync, rename over. The fsync is the log's own write discipline; without
 * it a POST answered 200 could evaporate on a crash, and the person's
 * choice with it. The record directory must already exist - a caller
 * creating one goes through the mint.
 */
export const writeDriverPreference = (
  dir: string,
  choice: DriverChoice,
  expectedConversationId = readRecordIdentity(dir),
): DriverPreference =>
  withRecordLock(pathsForDir(dir), expectedConversationId, () => {
    if (!isDriverHarness(choice.harness)) {
      throw new StoreError(
        "corrupt-log",
        `malformed driver harness on write: ${JSON.stringify(choice.harness)}`,
      );
    }
    for (const [name, value] of Object.entries({
      provider: choice.provider,
      model: choice.model,
      effort: choice.effort,
    })) {
      if (value !== undefined && !isDriverField(value)) {
        throw new StoreError("corrupt-log", `malformed driver ${name} on write`);
      }
    }
    const file: DriverPreference = {
      v: 1,
      harness: choice.harness,
      ...(choice.provider === undefined ? {} : { provider: choice.provider }),
      ...(choice.model === undefined ? {} : { model: choice.model }),
      ...(choice.effort === undefined ? {} : { effort: choice.effort }),
    };
    const path = pathsForDir(dir).driverPath;
    // Same directory, so the rename is on one filesystem and is atomic. The
    // pid keeps a second writer's temporary from colliding with this one;
    // within one process the write and rename are synchronous and cannot
    // interleave.
    const tmp = `${path}.${process.pid}.part`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeAll(fd, Buffer.from(JSON.stringify(file)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    return file;
  });
