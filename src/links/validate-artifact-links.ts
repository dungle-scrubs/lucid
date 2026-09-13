import type { ArtifactLinkRefusal } from "../protocol/artifact-links.js";
import { artifactLinks, linkRefusal } from "../protocol/artifact-links.js";
import type { WebLinkProbe } from "./check-web-link.js";
import { checkWebLink, untilAborted } from "./check-web-link.js";

/** Fixed limits and document-order results make policy deterministic; only the
 * injected probe observes the network. No lock is held here. */
export async function validateArtifactLinks(
  bytes: string,
  signal: AbortSignal,
  probe: WebLinkProbe = checkWebLink,
): Promise<ArtifactLinkRefusal | null> {
  const parsed = artifactLinks(bytes);
  if ("verdict" in parsed) return parsed;
  const total = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const results: Array<ArtifactLinkRefusal | null> = [];
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < parsed.urls.length) {
      const index = next++;
      const url = parsed.urls[index];
      if (!url) return;
      const deadline = AbortSignal.any([total, AbortSignal.timeout(10_000)]);
      try {
        deadline.throwIfAborted();
        const result = await untilAborted(probe(url, deadline), deadline);
        results[index] =
          result.status === "valid"
            ? null
            : linkRefusal(
                result.status === "broken" ? "artifact-link-broken" : "artifact-link-unverified",
                url,
                result.reason,
              );
      } catch {
        results[index] = linkRefusal(
          "artifact-link-unverified",
          url,
          "check cancelled, timed out, or failed",
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, parsed.urls.length) }, run));
  if (signal.aborted) return linkRefusal("artifact-link-unverified", "", "admission cancelled");
  return results.find((result) => result !== null) ?? null;
}
