import { mountOverlay } from "./overlay/overlay.ts";
import type { TrustedOutlinePort } from "./overlay/browser-artifact-outline.ts";
import type { TrustedOverlayCapabilities } from "./overlay/trusted-overlay.ts";

/**
 * The overlay bundle, injected into the artifact's sandboxed iframe (D-042,
 * D-067). Deliberately separate from the chrome bundle: this code runs inside
 * a document Lucid does not own, so it stays Lit + shadow DOM (the artifact's
 * CSS must not reach it, and its CSS must not reach the artifact) and carries
 * none of the chrome's React/Tailwind weight into the sandbox.
 */
export const bootOverlay = (
  outlinePort: TrustedOutlinePort,
  tagName: string,
  capabilities: TrustedOverlayCapabilities,
): void => mountOverlay(outlinePort, tagName, capabilities);
