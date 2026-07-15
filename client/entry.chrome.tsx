import { createRoot } from "react-dom/client";
import { Chrome } from "./chrome/Chrome.tsx";

/**
 * The chrome bundle, loaded only by Lucid's own viewer page. It renders into
 * the light DOM on purpose: the artifact is isolated behind an opaque-origin
 * iframe (D-020), so the chrome needs no shadow root of its own - and Tailwind
 * is a global stylesheet that a shadow root would shut out.
 */
const host = document.getElementById("lucid-root");
if (!host) throw new Error("lucid: #lucid-root missing from the viewer page");
createRoot(host).render(<Chrome />);
