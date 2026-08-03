/**
 * The bundles the browser loads, as responses rather than as bytes.
 *
 * Every Lucid server serves the same four: the chrome's script and stylesheet,
 * the overlay bootstrap the sandboxed artifact loads, and the viewer's own
 * icon. What varies per asset - content type, cache policy, whether the dev
 * override applies, and the CORS grant exactly one of them needs - is decided
 * HERE, so a hub and a per-session server cannot answer the same request with
 * different headers.
 */

import {
  CHROME_BUNDLE,
  CHROME_CSS,
  CLIENT_BUNDLE,
  FAVICON_SVG,
} from "./client-bundle.generated.ts";
import { readDevAsset } from "./dev-assets.ts";

/** The overlay bootstrap is `client.js`; the chrome is `chrome.js` +
 *  `chrome.css`; `favicon.ico` is the viewer's own icon (an SVG, whatever the
 *  extension the browser asks for says). */
export type BundleAsset = "chrome.js" | "chrome.css" | "client.js" | "favicon.ico";

const CONTENT_TYPE: Readonly<Record<BundleAsset, string>> = {
  "chrome.js": "text/javascript; charset=utf-8",
  "chrome.css": "text/css; charset=utf-8",
  "client.js": "text/javascript; charset=utf-8",
  "favicon.ico": "image/svg+xml",
};

const EMBEDDED: Readonly<Record<BundleAsset, string>> = {
  "chrome.js": CHROME_BUNDLE,
  "chrome.css": CHROME_CSS,
  "client.js": CLIENT_BUNDLE,
  "favicon.ico": FAVICON_SVG,
};

/**
 * Serve one bundle asset.
 *
 * The three script/style assets take the dev override when `LUCID_DEV_ASSETS`
 * is set (dev-assets.ts) and are never cached, so a rebuilt bundle reaches a
 * running server. The icon is embedded only and cached for a day - it is the
 * one asset that does not change with the build.
 *
 * `client.js` alone carries a CORS grant: it must be reachable from the
 * sandboxed artifact iframe, which loads it cross-origin (opaque origin ->
 * `Origin: null`). Callers serve it BEFORE the Host/Origin gate for that
 * reason - a placement this function cannot make on their behalf, and one the
 * other three must not share.
 */
export const serveBundleAsset = async (name: BundleAsset, req: Request): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": CONTENT_TYPE[name] };
  if (name === "favicon.ico") {
    headers["cache-control"] = "max-age=86400";
    return new Response(EMBEDDED[name], { headers });
  }
  headers["cache-control"] = "no-store";
  if (name === "client.js") {
    const origin = req.headers.get("origin");
    headers["access-control-allow-origin"] = origin ?? "*";
    headers["access-control-allow-credentials"] = "true";
    // Only when the answer actually varied by the request's Origin: a `*`
    // grant is the same bytes for everyone.
    if (origin !== null) headers.vary = "Origin";
  }
  return new Response((await readDevAsset(name)) ?? EMBEDDED[name], { headers });
};
