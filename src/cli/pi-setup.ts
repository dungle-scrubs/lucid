import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { materializePiExtension } from "../harness/pi-extension.js";
import { atomicSidecar } from "../store/atomic-file.js";
import { type AppendLock, acquireAppendLock, LockError } from "../store/flock.js";
import type { HookSetupResult } from "./hook-setup.js";
import { selfInvocation } from "./invocation.js";

const INVALID_MESSAGE = "The Pi settings file is not valid. Its contents were kept.";
const UNREADABLE_MESSAGE = "The Pi settings file could not be read. It was not changed.";
const INSTALLED_MESSAGE =
  "Lucid's Pi extension is configured in this Pi settings file. Start a new Pi session so the extension's session_start registers it. Setup alone does not mean Lucid is listening.";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One Lucid extension entry under this record root: `<root>/.integrations/pi/lucid-*.js`. */
const isLucidEntry = (root: string, entry: string): boolean =>
  entry.startsWith(join(root, ".integrations", "pi", "lucid-")) && entry.endsWith(".js");

/** Pi settings `extensions` array: configuration installation does not establish native
 * trust, registration or listening. */
export function setupPiExtension(root: string, settingsFile: string): HookSetupResult {
  const file = resolve(settingsFile);
  const result = (
    status: HookSetupResult["status"],
    message: string,
    reason: string | null = null,
  ): HookSetupResult => ({
    hooksFile: file,
    message,
    ready: false,
    reason,
    status,
    trustRequired: true,
  });
  // The extension file is content-addressed, so materializing it never depends
  // on the settings file's state and can run before the lock (RFC 28 slice 5).
  const base = resolve(root);
  let extensionPath: string;
  try {
    extensionPath = materializePiExtension(base, { command: selfInvocation([]), root: base });
  } catch {
    return result(
      "refused",
      "Lucid could not write its Pi extension file. The Pi settings file was not changed.",
      "extension-write-failed",
    );
  }
  let lock: AppendLock;
  try {
    mkdirSync(dirname(file), { mode: 0o700, recursive: true });
    lock = acquireAppendLock(`${file}.lucid-setup`, { privateFile: true, timeoutMs: 0 });
  } catch (cause) {
    const busy = cause instanceof LockError && cause.code === "lock-timeout";
    return result(
      "refused",
      busy
        ? "Another setup is changing this Pi settings file. Retry after it finishes."
        : "Setup could not lock this Pi settings file. Check access before retrying.",
      busy ? "settings-busy" : "settings-lock-unavailable",
    );
  }
  try {
    let raw: unknown;
    let mode: number | undefined;
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink())
      return result(
        "refused",
        "This Pi settings file is a deployed symlink. Use its managed source file for setup.",
        "settings-symlink",
      );
    if (!existing) {
      raw = {};
    } else {
      let fd: number | undefined;
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1_048_576 || stat.uid !== process.getuid?.())
          return result("refused", UNREADABLE_MESSAGE, "settings-unreadable");
        try {
          raw = JSON.parse(readFileSync(fd, "utf8"));
        } catch {
          return result("refused", INVALID_MESSAGE, "settings-invalid");
        }
        mode = stat.mode & 0o777;
      } catch (cause) {
        // The file can disappear between the lstat and the open; that is a missing file.
        if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") raw = {};
        else return result("refused", UNREADABLE_MESSAGE, "settings-unreadable");
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (!object(raw)) return result("refused", INVALID_MESSAGE, "settings-invalid");
    const extensions = raw.extensions;
    if (
      extensions !== undefined &&
      (!Array.isArray(extensions) || extensions.some((entry) => typeof entry !== "string"))
    )
      return result("refused", INVALID_MESSAGE, "settings-invalid");
    const current = extensions === undefined ? [] : (extensions as string[]);
    // Old Lucid entries under this root drop out; everything else keeps its order.
    const next = [...current.filter((entry) => !isLucidEntry(base, entry)), extensionPath];
    const changed = !isDeepStrictEqual(next, current);
    if (changed) {
      try {
        // The mode is set on the temporary file before the rename, so a completed
        // rename always leaves the settings file with its intended mode.
        atomicSidecar(file, { ...raw, extensions: next }, mode ?? 0o600);
      } catch {
        return result(
          "refused",
          "The Pi settings could not be saved. Check access before retrying setup.",
          "settings-write-failed",
        );
      }
    }
    return result(changed ? "installed" : "unchanged", INSTALLED_MESSAGE);
  } finally {
    lock.release();
  }
}
