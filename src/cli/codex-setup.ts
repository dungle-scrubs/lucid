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
import { selfInvocation } from "./invocation.js";

export interface CodexSetupResult {
  readonly hooksFile: string;
  readonly message: string;
  readonly ready: false;
  readonly reason: string | null;
  readonly status: "installed" | "unchanged" | "refused";
  readonly trustRequired: true;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The native hook format accepts a shell command, so each argument is quoted independently. */
function hookCommand(root: string): string {
  return selfInvocation(["_codex-hook", "--root", root])
    .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

/** Configuration installation does not establish native trust, registration or listening. */
export function setupCodexHooks(root: string, hooksFile: string): CodexSetupResult {
  const file = resolve(hooksFile);
  const result = (
    status: CodexSetupResult["status"],
    message: string,
    reason: string | null = null,
  ): CodexSetupResult => ({
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
    const command = hookCommand(root);
    const events = [
      {
        event: "SessionStart",
        timeout: 60,
        statusMessage: "Preparing this session for Lucid feedback",
      },
      {
        event: "Stop",
        timeout: 60,
        statusMessage: "Listening for Lucid feedback (up to 45 seconds)",
      },
      { event: "Interrupt", timeout: 3, statusMessage: "Stopping Lucid feedback listening" },
    ];
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
          if (typeof entry.command !== "string" || !entry.command.includes("_codex-hook")) continue;
          const expected = events.find((candidate) => candidate.event === event);
          if (
            !expected ||
            installed.has(event) ||
            !isDeepStrictEqual(entry, {
              command,
              statusMessage: expected.statusMessage,
              timeout: expected.timeout,
              type: "command",
            }) ||
            Object.keys(group).some((key) => key !== "hooks" && key !== "matcher") ||
            (group.matcher !== undefined && group.matcher !== "" && group.matcher !== "*")
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
    for (const { event, timeout, statusMessage } of events) {
      const groups = hooks[event] ?? [];
      if (!Array.isArray(groups))
        return result(
          "refused",
          "An existing hook event is invalid. Its contents were kept.",
          "hooks-invalid",
        );
      const handler = { command, statusMessage, timeout, type: "command" };
      if (installed.has(event)) continue;
      hooks[event] = [...groups, { hooks: [handler] }];
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
    return result(
      changed ? "installed" : "unchanged",
      "Lucid hooks are configured. Review and trust them in Codex /hooks, then start or resume the intended session so SessionStart can register it. Setup alone does not mean Lucid is listening.",
    );
  } finally {
    lock.release();
  }
}
