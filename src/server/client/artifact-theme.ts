import { artifactMetadata } from "./artifact-metadata.js";
import type { Appearance } from "./theme.js";

export type ArtifactTheme = Appearance | "adaptive" | "unmanaged";

export function preferredArtifactTheme(bytes: string): ArtifactTheme {
  const value = artifactMetadata(bytes, "lucid-theme")?.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  return value === "light" || value === "dark" || value === "adaptive" ? value : "unmanaged";
}

export function artifactColorScheme(
  policy: ArtifactTheme,
  appearance: Appearance,
): Appearance | "light dark" {
  return policy === "adaptive" ? appearance : policy === "unmanaged" ? "light dark" : policy;
}
