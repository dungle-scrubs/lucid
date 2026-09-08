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

import { readFileSync } from "node:fs";
import { isProfile, SETTINGS_FIELDS } from "../protocol/driver-settings.js";
import { HARNESS_NAMES, type HarnessName } from "../protocol/frames.js";
import { HubError } from "../protocol/hub-errors.js";
import { atomicSidecar } from "./atomic-file.js";
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
  readonly profile?: import("../protocol/driver-settings.js").SelectedProfile;
  readonly harness: HarnessName;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** What the file holds: the choice under a version stamp, like `meta.json`
 * carries its `v: 1`. What the read returns and the projection reports -
 * RFC-12 says the page is told the file's content. */
export interface DriverPreference {
  readonly profile?: import("../harness/runner.js").HarnessMode;
  readonly revision?: number;
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

/** Read saved settings without hiding malformed fields behind defaults. */
export function preferenceState(dir: string): {
  preference: DriverPreference | null;
  revision: number;
  error: string | null;
} {
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(readFileSync(pathsForDir(dir).driverPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { preference: null, revision: 0, error: null };
    return {
      preference: null,
      revision: 0,
      error: "Saved settings cannot be read. Choose complete settings to repair them.",
    };
  }
  const revision =
    Number.isSafeInteger(file?.revision) && Number(file.revision) >= 0 ? Number(file.revision) : 0;
  if (
    file?.v !== 1 ||
    !isDriverHarness(file.harness) ||
    ["model", "effort", "provider"].some((k) => file[k] !== undefined && !isDriverField(file[k])) ||
    (file.profile !== undefined && !isProfile(file.profile)) ||
    (file.revision !== undefined && file.revision !== revision)
  )
    return {
      preference: null,
      revision,
      error: "Saved settings are malformed. Choose complete settings to repair them.",
    };
  const preference = Object.fromEntries(
    Object.entries(file).filter(([key]) =>
      ([...SETTINGS_FIELDS, "v", "revision"] as readonly string[]).includes(key),
    ),
  ) as unknown as DriverPreference;
  return { preference, revision, error: null };
}

export const readDriverPreference = (dir: string): DriverPreference | null =>
  preferenceState(dir).preference;

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
  expectedRevision?: number,
): DriverPreference =>
  withRecordLock(pathsForDir(dir), expectedConversationId, () =>
    replacePreferenceUnderLock(dir, choice, expectedRevision),
  );

function replacePreferenceUnderLock(
  dir: string,
  choice: DriverChoice,
  expectedRevision?: number,
): DriverPreference {
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
  const current = preferenceState(dir);
  if (expectedRevision !== undefined && current.revision !== expectedRevision)
    throw new HubError("Settings changed. Reload before saving.", "E-HUB-02", 409, [
      "Reload settings",
    ]);
  if (expectedRevision === undefined && current.revision > 0)
    throw new HubError("A revision is required to replace saved settings.", "E-HUB-02", 409, [
      "Reload settings",
    ]);
  if (choice.profile !== undefined && !isProfile(choice.profile))
    throw new StoreError("corrupt-log", "malformed driver profile on write");
  const file: DriverPreference = {
    v: 1,
    harness: choice.harness,
    ...(choice.profile === undefined ? {} : { profile: choice.profile }),
    ...(expectedRevision === undefined ? {} : { revision: expectedRevision + 1 }),
    ...(choice.provider === undefined ? {} : { provider: choice.provider }),
    ...(choice.model === undefined ? {} : { model: choice.model }),
    ...(choice.effort === undefined ? {} : { effort: choice.effort }),
  };
  atomicSidecar(pathsForDir(dir).driverPath, file);
  return file;
}

/** Called only by input admission while holding the record append lock. A newer explicit choice wins. */
export function completeLegacyPreference(dir: string, selected: DriverChoice): void {
  const current = preferenceState(dir);
  if (current.error || current.revision > 0) return;
  replacePreferenceUnderLock(dir, selected, 0);
}

/** Execution cannot treat unreadable settings as permission to use defaults. */
export function requireDriverPreference(dir: string): DriverPreference | null {
  const state = preferenceState(dir);
  if (state.error) throw new HubError(state.error, "E-HUB-03");
  return state.preference;
}
