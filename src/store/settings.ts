import type { Settings } from "../config/user-config.js";
import { HubError } from "../protocol/hub-errors.js";
import { folderSummary } from "./discovery.js";
import { type DriverPreference, writeDriverPreference } from "./driver-preference.js";

export { preferenceState } from "./driver-preference.js";

import { atomicSidecar } from "./atomic-file.js";
import { pathsForDir } from "./errors.js";
import { associateFolder } from "./project-directory.js";
import { readRecordMetadata, withRecordLock } from "./record-identity.js";

export function replaceSettings(
  dir: string,
  id: string,
  expected: number,
  settings: Settings,
): DriverPreference {
  return writeDriverPreference(dir, settings, id, expected);
}
export function replaceLocation(
  dir: string,
  id: string,
  expected: number,
  folder: string,
): Record<string, unknown> {
  let association: ReturnType<typeof associateFolder>;
  try {
    association = associateFolder(folder);
  } catch {
    throw new HubError(
      "Working folder is missing or inaccessible. Choose an available folder.",
      "E-HUB-04",
      400,
      ["Choose a working folder"],
    );
  }
  return withRecordLock(pathsForDir(dir), id, () => {
    const meta = readRecordMetadata(dir);
    if ((meta.locationRevision ?? 0) !== expected)
      throw new HubError("Working folder changed. Reload before saving.", "E-HUB-02", 409, [
        "Reload folder",
      ]);
    if (meta.managedWorkspace === true && association.workingDirectory === meta.workingDirectory)
      return locationProjection(meta);
    const next = {
      ...meta,
      ...association,
      ...(meta.managedWorkspace === true ? { managedWorkspace: false } : {}),
      locationRevision: expected + 1,
    };
    atomicSidecar(pathsForDir(dir).metaPath, next);
    return locationProjection(next);
  });
}

export function locationProjection(meta: Record<string, unknown>) {
  const summary = folderSummary(meta);
  return {
    workingDirectory: summary.workingDirectory,
    projectDirectory: summary.projectDirectory,
    status: summary.workingDirectoryStatus,
    revision: meta.locationRevision ?? 0,
  };
}
