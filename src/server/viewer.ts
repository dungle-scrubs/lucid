/**
 * The Lucid-owned documents the browser opens, and the one place they are
 * spelled.
 *
 * The viewer (chrome) parent page (RFC §1) hosts the chrome (composer,
 * conversation log, queued annotations, controls) and an isolated
 * `<iframe src="/">` whose document is the artifact with the injected overlay.
 * The shell page is the same bundle in its other mode. Both are served from a
 * control route, never from the artifact directory, so they cannot bypass the
 * asset allowlist (D-054) - and both boot by handing the client ONE declared
 * config object, so what the server writes and what the client reads cannot
 * drift into two spellings.
 */

import { readFile } from "node:fs/promises";
import type { Config, ShellConfig } from "../../client/chrome/types.ts";
import { escapeHtml } from "../core/escape.ts";
import { sessionState } from "../core/log.ts";
import type { SessionPaths } from "../core/paths.ts";
import { renderInjected } from "./inject.ts";

export interface ViewerConfig {
  readonly session: string;
  readonly name: string;
  readonly port: number;
  readonly version: number;
  /** URL prefix of this session's routes: "" on a dedicated server, "/s/<id>"
   *  under the daemon. Baked into the page so the chrome's transport and the
   *  static hrefs below address THIS session, whichever server mounts it. */
  readonly base?: string;
}

const htmlNoStore = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
} as const;

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

/** The LUCID_STREAM_CAP seam (M3.1): how many session streams a shell window
 *  keeps connected. A test knob - the eviction behavior is only exercisable
 *  without opening 11 real tabs - so anything that is not a positive integer
 *  leaves the client's own default in place. */
export const streamCapFromEnv = (env: NodeJS.ProcessEnv = process.env): number | undefined => {
  const raw = Number(env.LUCID_STREAM_CAP);
  return Number.isInteger(raw) && raw > 0 ? raw : undefined;
};

const escapeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * The page that boots the chrome bundle, in either of its modes.
 *
 * The config is serialized off its DECLARED type rather than concatenated as
 * string fragments: the client reads the same declaration back
 * (`client/chrome/types.ts`), so a renamed field is a type error here instead
 * of a value that silently stops arriving.
 */
export const renderBootPage = (config: Config | ShellConfig, base = ""): string => {
  // A discriminated union, not a cast: `mode` is a literal on both sides, so
  // the branch below is what narrows `config` and a payload can only be
  // written under the global name its own type belongs to.
  const shell = config.mode === "shell";
  const payload = escapeJson(config);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/svg+xml" href="${base}/favicon.ico" />
<title>${shell ? "Lucid" : `Lucid · ${escapeHtml(config.name)}`}</title>
<link rel="stylesheet" href="${base}/__lucid/chrome.css" />
</head>
<body>
<script>window.${shell ? "__LUCID_SHELL__" : "__LUCID__"} = ${
    shell ? payload : `Object.assign({ mode: "chrome", base: "" }, ${payload})`
  };</script>
<div id="lucid-root"></div>
<script type="module" src="${base}/__lucid/chrome.js"></script>
</body>
</html>`;
};

export const renderViewer = (config: ViewerConfig): string => {
  const base = config.base ?? "";
  const sseMaxBackoffMs = sseMaxBackoffFromEnv();
  return renderBootPage(
    {
      mode: "chrome",
      ...config,
      base,
      ...(sseMaxBackoffMs === undefined ? {} : { sseMaxBackoffMs }),
    },
    base,
  );
};

/** `{base}/__lucid/viewer` - the review page, rendered for the base the
 *  session is actually mounted under. */
export const viewerResponse = (config: ViewerConfig): Response =>
  new Response(renderViewer(config), { headers: htmlNoStore });

/** The shell page: boots the chrome bundle in shell mode. The client fetches
 *  `/hub/sessions` and tails `/hub/events` itself - this page only carries the
 *  mode flag and the seams a test harness sets. */
export const renderShellPage = (): string => {
  const sseMaxBackoffMs = sseMaxBackoffFromEnv();
  const streamCap = streamCapFromEnv();
  return renderBootPage({
    mode: "shell",
    ...(sseMaxBackoffMs === undefined ? {} : { sseMaxBackoffMs }),
    ...(streamCap === undefined ? {} : { streamCap }),
  });
};

/** `/` on the hub - the shell window itself. */
export const shellResponse = (): Response =>
  new Response(renderShellPage(), { headers: htmlNoStore });

/**
 * The stand-in document served in the surface iframe when there is no artifact
 * to serve, in the two states that can mean.
 *
 * It heals itself. The 404 that brought a reader here is very often momentary -
 * a session is created a beat before its first version is committed, and a page
 * that asked in that gap used to sit on this screen until someone reloaded by
 * hand. Nothing else can fix that from outside: there is no overlay in this
 * document, so the chrome's live-swap has nothing to talk to. So the page keeps
 * asking, backing off as it goes, and reloads the moment the artifact answers.
 */
const missingArtifactDoc = (opened: boolean): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${opened ? "Artifact missing" : "Waiting for the artifact"}</title></head>
<body style="font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#4c566a;background:#eceff4">
<div style="max-width:420px;text-align:center;font-size:13px;line-height:1.6">
${
  opened
    ? `<p style="font-weight:600">This session's artifact file is missing.</p>
<p>Nothing is served for it right now - the file may have been moved or deleted. Reopening it (<code>lucid open</code> on the artifact) rebuilds this view, and this page comes back on its own when the file does.</p>`
    : `<p style="font-weight:600">Waiting for this session's first version.</p>
<p>The session is open but nothing has been committed to it yet. This page shows the artifact as soon as it lands - there is nothing to do.</p>`
}
</div>
<script>
(() => {
  // Reload, rather than fetch-then-reload: this frame is sandboxed WITHOUT
  // allow-same-origin (D-020), so it is an opaque origin - a fetch back to its
  // own URL is cross-origin and would be refused, while navigating itself is
  // not. A reload that finds the artifact simply renders it, overlay and all.
  //
  // The backoff rides in window.name because it must survive the reload, and
  // the opaque origin has no storage to keep it in: sessionStorage throws
  // there, and the URL is the artifact's own (a retry counter left in its hash
  // would outlive the wait). Nothing else reads the frame's name.
  const KEY = "lucid-retry:";
  const n = window.name.startsWith(KEY) ? Number(window.name.slice(KEY.length)) || 0 : 0;
  window.name = KEY + (n + 1);
  const wait = Math.min(Math.round(700 * 1.4 ** n), 15000);
  // A hidden tab waits rather than reloading: the answer is only wanted by
  // someone looking at it, and a forgotten tab must not reload all day.
  const go = () =>
    document.visibilityState === "hidden" ? setTimeout(go, 2000) : location.reload();
  setTimeout(go, wait);
})();
</script>
</body></html>`;

/**
 * `{base}/` - the artifact document with the overlay injected, for the base it
 * is mounted under.
 *
 * The missing case renders INSIDE the surface iframe, where raw JSON reads as
 * a broken app: it is a document, whichever server answers. WHICH wrong thing
 * it says depends on the log - a session whose first version has not been
 * committed yet has nothing to serve for a second or two during creation, and
 * calling that a moved-or-deleted file is a lie told at the one moment the
 * human is most likely to be looking.
 */
export const artifactDocumentResponse = async (
  paths: SessionPaths,
  base: string,
  origin: string,
): Promise<Response> => {
  const html = await readFile(paths.currentHtml, "utf8").catch(() => null);
  if (html === null) {
    const opened = (await sessionState(paths)).status !== "none";
    return new Response(missingArtifactDoc(opened), { status: 404, headers: htmlNoStore });
  }
  const injected = renderInjected(html, base, origin);
  return new Response(injected.body, { headers: { ...htmlNoStore, ...injected.headers } });
};
