/**
 * The viewer (chrome) parent page (RFC §1). This Lucid-owned document is what
 * the browser opens. It hosts the chrome (composer, conversation log, queued
 * annotations, controls) and an isolated `<iframe src="/">` whose document is
 * the artifact with the injected overlay. Served from a control route, never
 * from the artifact directory, so it cannot bypass the asset allowlist (D-054).
 */

import { escapeHtml } from "../core/escape.ts";

export interface ViewerConfig {
  readonly session: string;
  readonly name: string;
  readonly port: number;
  readonly version: number;
  /** URL prefix of this session's routes: "" on a dedicated server, "/s/<id>"
   *  under the daemon. Baked into the page so the chrome's transport and the
   *  static hrefs below address THIS session, whichever server mounts it. */
  readonly base?: string;
  /** Cap on the chrome's fatal-stream reconnect backoff, ms (D-015 seam). */
  readonly sseMaxBackoffMs?: number;
}

/**
 * The LUCID_SSE_MAX_BACKOFF_MS seam, parsed the strict way: the whole string
 * must be a positive integer, because `parseInt("5s")` silently half-applies
 * a typo. Absent or malformed means production behaviour (the 15s ceiling) -
 * a harness knob must never be able to make the product WORSE than default,
 * so the client clamps to the ceiling as well.
 */
export const sseMaxBackoffFromEnv = (env: NodeJS.ProcessEnv = process.env): number | undefined => {
  const raw = env.LUCID_SSE_MAX_BACKOFF_MS;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : undefined;
};

const escapeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

export const renderViewer = (config: ViewerConfig): string => {
  const base = config.base ?? "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/svg+xml" href="${base}/favicon.ico" />
<title>Lucid · ${escapeHtml(config.name)}</title>
<link rel="stylesheet" href="${base}/__lucid/chrome.css" />
</head>
<body>
<script>window.__LUCID__ = Object.assign({ mode: "chrome", base: "" }, ${escapeJson({ ...config, base })});</script>
<div id="lucid-root"></div>
<script type="module" src="${base}/__lucid/chrome.js"></script>
</body>
</html>`;
};
