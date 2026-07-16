import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Warning } from "../errors.ts";

/**
 * Static-asset security (D-018, D-037, D-054). Even on loopback the server is
 * guarded: Host/Origin validation (DNS-rebind defense), `..`/symlink scoping,
 * a dotfile/dot-directory denylist with a `/.well-known/` carve-out, and an
 * enumerated extension allowlist for non-document files.
 */

/** Enumerated static-asset extension allowlist (D-054). */
export const ASSET_EXTENSIONS = new Set([
  "html",
  "css",
  "js",
  "mjs",
  "map",
  "json",
  "csv",
  "txt",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "wasm",
  "webmanifest",
  "mp4",
  "webm",
  "mp3",
  "ogg",
  "pdf",
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  map: "application/json; charset=utf-8",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  webmanifest: "application/manifest+json",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  pdf: "application/pdf",
};

export const contentTypeFor = (ext: string): string =>
  CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";

const extOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash && dot !== -1 ? path.slice(dot + 1).toLowerCase() : "";
};

/** True if a host header points at the loopback interface on the given port. */
export const isLoopbackHost = (host: string | null, port: number): boolean => {
  if (!host) return false;
  const [name, p] = host.split(":");
  if (p !== undefined && Number.parseInt(p, 10) !== port) return false;
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
};

/** Validate Host header (always) and Origin (when present) against our origin. */
export const validateHeaders = (
  req: Request,
  port: number,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  const host = req.headers.get("host");
  if (!isLoopbackHost(host, port)) {
    return { ok: false, reason: `non-loopback Host: ${host ?? "(none)"}` };
  }
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, reason: `malformed Origin: ${origin}` };
    }
    if (!isLoopbackHost(originHost, port)) {
      return { ok: false, reason: `cross-origin request: ${origin}` };
    }
  }
  return { ok: true };
};

export type AssetResolution =
  | { readonly ok: true; readonly absPath: string; readonly contentType: string }
  | { readonly ok: false; readonly status: number; readonly warning: Warning };

/**
 * Resolve a request pathname to a real file under `root`, enforcing the
 * traversal / dotfile / symlink / extension rules. The artifact document route
 * (`GET /`) is handled separately and does NOT pass through here.
 */
export const resolveAsset = (pathname: string, root: string): AssetResolution => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return assetDenied(400, "ASSET_DENIED", `malformed path: ${pathname}`);
  }

  const segments = decoded.split("/").filter((s) => s.length > 0);

  // Reject traversal and dot-prefixed components, with a /.well-known/ carve-out.
  const isWellKnown = segments[0] === ".well-known";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? "";
    if (seg === "..") {
      return assetDenied(403, "ASSET_DENIED", `path traversal: ${decoded}`);
    }
    if (seg.startsWith(".") && !(i === 0 && isWellKnown)) {
      return assetDenied(403, "ASSET_DENIED", `dotfile/dot-directory: ${decoded}`);
    }
  }

  const ext = extOf(decoded);
  if (!ASSET_EXTENSIONS.has(ext)) {
    return assetDenied(
      403,
      "ASSET_DENIED",
      `disallowed asset type: .${ext || "(none)"} (${decoded})`,
    );
  }

  const candidate = resolve(root, ...segments);
  // Must stay within root (string check on the resolved, pre-symlink path).
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return assetDenied(403, "ASSET_DENIED", `escapes served root: ${decoded}`);
  }
  // Symlink escape check: the candidate's realpath must stay within the root's
  // realpath. Comparing both realpaths handles a root that itself lives under a
  // symlinked prefix (e.g. macOS /var -> /private/var).
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  try {
    const real = realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return assetDenied(403, "ASSET_DENIED", `symlink escapes served root: ${decoded}`);
    }
  } catch {
    // File does not exist; the 404 is handled by the caller via Bun.file.exists.
  }

  return { ok: true, absPath: candidate, contentType: contentTypeFor(ext) };
};

const assetDenied = (status: number, code: Warning["code"], message: string): AssetResolution => ({
  ok: false,
  status,
  warning: { code, message },
});
