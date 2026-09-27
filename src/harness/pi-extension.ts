import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The part of Pi's extension API this extension reads (Pi 0.87.1). */
interface PiSessionManager {
  getEntries(): readonly { readonly type: string }[];
  getHeader(): { readonly cwd?: string; readonly id?: string } | null | undefined;
  getSessionId(): string;
}
interface PiContext {
  readonly cwd: string;
  readonly mode: string;
  readonly sessionManager: PiSessionManager;
}
type PiInputResult = { readonly action: "continue" | "handled" } | undefined;
export interface PiExtensionApi {
  on(event: "session_start", handler: (event: unknown, ctx: PiContext) => void): void;
  on(event: "input", handler: (event: unknown, ctx: PiContext) => PiInputResult): void;
}

/**
 * The Lucid Pi extension (RFC 28). It runs inside Pi, not inside Lucid:
 * `piExtensionSource` serializes it with `Function.prototype.toString`, so
 * it references nothing outside its own body except globals.
 *
 * Headless role, set by `LUCID_PI_ATTEMPT` in a `json` or `print` run:
 * check the session and folder Pi opened, write the attestation file, and
 * let the prompt reach the model only when the check passed. The `input`
 * handler is the only pre-model gate in Pi, so it denies unless verified
 * and cannot throw. The variables leave `process.env` before any tool runs.
 */
export function lucidPiExtension(pi: PiExtensionApi): void {
  const env = process.env;
  const attemptValue = env.LUCID_PI_ATTEMPT;
  const expectedSession = env.LUCID_PI_EXPECTED_SESSION;
  const expectedCwd = env.LUCID_PI_EXPECTED_CWD;
  const attestationPath = env.LUCID_PI_ATTESTATION;
  delete env.LUCID_PI_ATTEMPT;
  delete env.LUCID_PI_EXPECTED_SESSION;
  delete env.LUCID_PI_EXPECTED_CWD;
  delete env.LUCID_PI_ATTESTATION;
  if (attemptValue === undefined) return;
  const fs = process.getBuiltinModule("node:fs");
  const attempt =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/.exec(
      attemptValue,
    );
  let role: "headless" | "none" | undefined;
  let verified = false;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "json" && ctx.mode !== "print") {
      role = "none";
      return;
    }
    role = "headless";
    process.exitCode = 3;
    if (!attempt || !expectedSession || !expectedCwd || !attestationPath) return;
    const real = (path: string | undefined): string | undefined => {
      try {
        return path === undefined ? undefined : fs.realpathSync.native(path);
      } catch {
        return undefined;
      }
    };
    const expectedReal = real(expectedCwd);
    const sameFolder = (path: string | undefined): boolean =>
      path === expectedCwd || (expectedReal !== undefined && real(path) === expectedReal);
    let opened = "";
    let reason: string | undefined;
    try {
      opened = ctx.sessionManager.getSessionId();
      const header = ctx.sessionManager.getHeader();
      if (opened !== expectedSession || header?.id !== expectedSession)
        reason = "session-id-mismatch";
      else if (!sameFolder(header.cwd) || !sameFolder(ctx.cwd)) reason = "folder-mismatch";
      else if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "message"))
        reason = "session-empty";
    } catch {
      reason = "verification-failed";
    }
    const record = {
      v: 1,
      attempt: attempt[1],
      nonce: attempt[2],
      outcome: reason === undefined ? "verified" : "refused",
      ...(reason === undefined ? {} : { reason }),
      expected: expectedSession,
      opened,
    };
    try {
      fs.writeFileSync(attestationPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      return;
    }
    if (reason === undefined) {
      verified = true;
      process.exitCode = 0;
    }
  });
  pi.on("input", () => {
    try {
      if (role === "none") return undefined;
      return verified ? { action: "continue" } : { action: "handled" };
    } catch {
      return { action: "handled" };
    }
  });
}

/** The extension file's text: an ES module whose default export is the extension. */
export function piExtensionSource(): string {
  return `// Lucid Pi extension (RFC 28). Written by Lucid; do not edit.\nexport default ${lucidPiExtension.toString()};\n`;
}

/** Write the extension under the record root, named by its content hash, and
 * return its path. An existing file with the same text is reused; any other
 * content at that path is replaced. Throws when the file cannot be written. */
export function materializePiExtension(root: string): string {
  const source = piExtensionSource();
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const dir = join(root, ".integrations", "pi");
  const path = join(dir, `lucid-${digest}.js`);
  try {
    if (readFileSync(path, "utf8") === source) return path;
  } catch {
    // Absent or unreadable: write it below.
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, source, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return path;
}
