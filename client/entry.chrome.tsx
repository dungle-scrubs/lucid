import { createRoot } from "react-dom/client";
import { Chrome } from "./chrome/Chrome.tsx";
import { Shell } from "./chrome/Shell.tsx";
import { ensureSession } from "./chrome/shell.ts";
import type { Config } from "./chrome/types.ts";

/**
 * The chrome bundle, loaded by two pages of the same UI:
 *
 * - a dedicated per-session server's viewer (`window.__LUCID__` present):
 *   boot that one session and fill the window with its view;
 * - the hub daemon's shell (`window.__LUCID_SHELL__`): boot the tab bar and
 *   let the human open sessions from the hub listing.
 *
 * It renders into the light DOM on purpose: the artifact is isolated behind
 * an opaque-origin iframe (D-020), so the chrome needs no shadow root of its
 * own - and Tailwind is a global stylesheet that a shadow root would shut out.
 *
 * A boot session is created and connected HERE, before React: the stream
 * belongs to the handle's lifetime in the shell roster, not to any view being
 * on screen - and creating it during a component's render would be a
 * render-phase write to the shell store that component reads.
 */
const host = document.getElementById("lucid-root");
if (!host) throw new Error("lucid: #lucid-root missing from the viewer page");

const single = (window as unknown as { __LUCID__?: Config }).__LUCID__;
if (single) {
  const session = ensureSession({ ...single, base: single.base ?? "" });
  session.connect();
  createRoot(host).render(<Chrome session={session} />);
} else {
  createRoot(host).render(<Shell />);
}
