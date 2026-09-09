import { useMemo } from "react";
import { artifactColorScheme, preferredArtifactTheme } from "./artifact-theme.js";
import type { Appearance } from "./theme.js";
import { useTheme } from "./use-theme.js";

export function useArtifactAppearance(bytes: string): Appearance | "light dark" {
  const { appearance } = useTheme();
  const policy = useMemo(() => preferredArtifactTheme(bytes), [bytes]);
  return artifactColorScheme(policy, appearance);
}
