import { mountChrome } from "./chrome/chrome.ts";
import { mountOverlay } from "./overlay/overlay.ts";

/**
 * Single browser bundle for both viewer contexts. The same file is loaded by
 * the chrome parent page and injected into the artifact iframe; the injected
 * `window.__LUCID__.mode` selects which half mounts.
 */
const config = (window as unknown as { __LUCID__?: { mode?: string } }).__LUCID__;

if (config?.mode === "overlay") {
  mountOverlay();
} else {
  mountChrome();
}
