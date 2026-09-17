import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicSidecar } from "../store/atomic-file.js";
import type { AppendLock } from "../store/flock.js";
import { acquireAppendLock, LockError } from "../store/flock.js";
import { selfInvocation, shellCommand } from "./invocation.js";

export interface HookSetupResult {
  readonly hooksFile: string;
  readonly message: string;
  readonly ready: false;
  readonly reason: string | null;
  readonly status: "installed" | "unchanged" | "refused";
  readonly trustRequired: true;
}

export interface LucidHookEvent {
  readonly event: string;
  /** Omitted for every occurrence; set to the exact matcher Lucid installs otherwise. */
  readonly matcher?: string;
  readonly statusMessage?: string;
  readonly timeout: number;
}

export interface HookSetupSpec {
  /** Hidden Lucid subcommand that identifies handlers this setup owns. */
  readonly entry: string;
  readonly events: readonly LucidHookEvent[];
  readonly installedMessage: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const everyOccurrence = (matcher: unknown): boolean =>
  matcher === undefined || matcher === "" || matcher === "*";

/** Configuration installation does not establish native trust, registration or listening. */
export function setupLucidHooks(
  root: string,
  hooksFile: string,
  spec: HookSetupSpec,
): HookSetupResult {
  const file = resolve(hooksFile);
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
  let lock: AppendLock;
  try {
    mkdirSync(dirname(file), { mode: 0o700, recursive: true });
    lock = acquireAppendLock(`${file}.lucid-setup`, { privateFile: true, timeoutMs: 0 });
  } catch (cause) {
    const busy = cause instanceof LockError && cause.code === "lock-timeout";
    return result(
      "refused",
      busy
        ? "Another setup is changing this hooks file. Retry after it finishes."
        : "Setup could not lock this hooks file. Check access before retrying.",
      busy ? "hooks-busy" : "hooks-lock-unavailable",
    );
  }
  try {
    let raw: unknown;
    let fd: number | undefined;
    try {
      const existing = lstatSync(file, { throwIfNoEntry: false });
      if (existing?.isSymbolicLink())
        return result(
          "refused",
          "This hooks file is a deployed symlink. Use its managed source file for setup.",
          "hooks-symlink",
        );
      if (!existing) {
        raw = {};
      } else {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1_048_576 || stat.uid !== process.getuid?.())
          return result(
            "refused",
            "The hooks file must be a bounded regular file owned by this user. Its contents were kept.",
            "hooks-invalid",
          );
        raw = JSON.parse(readFileSync(fd, "utf8"));
      }
    } catch {
      return result(
        "refused",
        "The hooks file could not be read as JSON. Its contents were kept.",
        "hooks-unreadable",
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (!object(raw) || (raw.hooks !== undefined && !object(raw.hooks)))
      return result(
        "refused",
        "The hooks configuration must contain a hooks object. Its contents were kept.",
        "hooks-invalid",
      );
    const hooks = { ...(raw.hooks as Record<string, unknown> | undefined) };
    // The native hook format accepts a shell command, so each argument is quoted independently.
    const command = shellCommand(selfInvocation([spec.entry, "--root", root]));
    const handler = (expected: LucidHookEvent): Record<string, unknown> => ({
      command,
      ...(expected.statusMessage === undefined ? {} : { statusMessage: expected.statusMessage }),
      timeout: expected.timeout,
      type: "command",
    });
    const installed = new Set<string>();
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups))
        return result(
          "refused",
          "An existing hook event is invalid. Its contents were kept.",
          "hooks-invalid",
        );
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks))
          return result(
            "refused",
            "An existing hook group is invalid. Its contents were kept.",
            "hooks-invalid",
          );
        for (const entry of group.hooks) {
          if (!object(entry))
            return result(
              "refused",
              "An existing hook handler is invalid. Its contents were kept.",
              "hooks-invalid",
            );
          if (typeof entry.command !== "string" || !entry.command.includes(spec.entry)) continue;
          const expected = spec.events.find((candidate) => candidate.event === event);
          if (
            !expected ||
            installed.has(event) ||
            !isDeepStrictEqual(entry, handler(expected)) ||
            Object.keys(group).some((key) => key !== "hooks" && key !== "matcher") ||
            (expected.matcher === undefined
              ? !everyOccurrence(group.matcher)
              : group.matcher !== expected.matcher)
          )
            return result(
              "refused",
              "An existing Lucid hook differs from this setup or is duplicated. Review the managed configuration before retrying. Its contents were kept.",
              "hooks-conflict",
            );
          installed.add(event);
        }
      }
    }
    let changed = false;
    for (const expected of spec.events) {
      const groups = hooks[expected.event] ?? [];
      if (!Array.isArray(groups))
        return result(
          "refused",
          "An existing hook event is invalid. Its contents were kept.",
          "hooks-invalid",
        );
      if (installed.has(expected.event)) continue;
      hooks[expected.event] = [
        ...groups,
        {
          ...(expected.matcher === undefined ? {} : { matcher: expected.matcher }),
          hooks: [handler(expected)],
        },
      ];
      changed = true;
    }
    if (changed) {
      try {
        atomicSidecar(file, { ...raw, hooks });
      } catch {
        return result(
          "refused",
          "The hooks configuration could not be saved. Check access before retrying setup.",
          "hooks-write-failed",
        );
      }
    }
    return result(changed ? "installed" : "unchanged", spec.installedMessage);
  } finally {
    lock.release();
  }
}
