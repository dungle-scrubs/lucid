/**
 * The viewer (chrome) parent page (RFC §1). This Lucid-owned document is what
 * the browser opens. It hosts the chrome (composer, conversation log, queued
 * annotations, controls) and an isolated `<iframe src="/">` whose document is
 * the artifact with the injected overlay. Served from a control route, never
 * from the artifact directory, so it cannot bypass the asset allowlist (D-054).
 */

export interface ViewerConfig {
  readonly session: string;
  readonly name: string;
  readonly port: number;
  readonly version: number;
}

const escapeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/** Escape a string for safe interpolation into HTML text content (e.g. <title>). */
const escapeHtmlText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const renderViewer = (config: ViewerConfig): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/svg+xml" href="/favicon.ico" />
<title>Lucid · ${escapeHtmlText(config.name)}</title>
<link rel="stylesheet" href="/__lucid/chrome.css" />
</head>
<body>
<script>window.__LUCID__ = Object.assign({ mode: "chrome" }, ${escapeJson(config)});</script>
<div id="lucid-root"></div>
<script type="module" src="/__lucid/chrome.js"></script>
</body>
</html>`;
