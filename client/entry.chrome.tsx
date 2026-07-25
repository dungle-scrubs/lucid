import { createRoot } from "react-dom/client";
import { Chrome } from "./chrome/Chrome.tsx";
import { ensureSession } from "./chrome/shell.ts";
import type { Config } from "./chrome/types.ts";

/**
 * The chrome bundle, loaded only by Lucid's own viewer page. It renders into
 * the light DOM on purpose: the artifact is isolated behind an opaque-origin
 * iframe (D-020), so the chrome needs no shadow root of its own - and Tailwind
 * is a global stylesheet that a shadow root would shut out.
 *
 * The boot session is created and connected HERE, before React: the stream
 * belongs to the handle's lifetime in the shell roster, not to any view being
 * on screen - and creating it during a component's render would be a
 * render-phase write to the shell store that component reads.
 */
const config = (window as unknown as { __LUCID__: Config }).__LUCID__;
const session = ensureSession({ ...config, base: "" });
session.connect();

const host = document.getElementById("lucid-root");
if (!host) throw new Error("lucid: #lucid-root missing from the viewer page");
createRoot(host).render(<Chrome session={session} />);
