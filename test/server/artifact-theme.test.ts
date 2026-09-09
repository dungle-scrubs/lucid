import { expect, test } from "bun:test";
import {
  artifactColorScheme,
  preferredArtifactTheme,
} from "../../src/server/client/artifact-theme.js";

test("each stored version selects its declared frame policy without inferring support", () => {
  for (const [markup, expected] of [
    ['<meta name="lucid-theme" content="adaptive">', "adaptive"],
    ['<META NAME="lucid-theme" CONTENT=" \tlight\n">', "light"],
    ['<meta name="lucid-theme" content="dark">', "dark"],
    ['<meta name="color-scheme" content="light dark">', "unmanaged"],
    ['<meta name="lucid-theme" content="Dark">', "unmanaged"],
    ['<meta name="lucid-theme" content="\u00a0dark">', "unmanaged"],
    ['<meta name="lucid-theme" content=""><meta name="lucid-theme" content="dark">', "unmanaged"],
    ['<!-- <meta name="lucid-theme" content="dark"> -->', "unmanaged"],
    ['<script>const example = \'<meta name="lucid-theme" content="dark">\';</script>', "unmanaged"],
    ['</head><body><meta name="lucid-theme" content="dark">', "unmanaged"],
  ] as const) {
    const policy = preferredArtifactTheme(
      `<html><head>${markup}</head><body>Content</body></html>`,
    );
    expect(policy).toBe(expected);
    expect(artifactColorScheme(policy, "light")).toBe(
      expected === "unmanaged" ? "light dark" : expected === "adaptive" ? "light" : expected,
    );
    expect(artifactColorScheme(policy, "dark")).toBe(
      expected === "unmanaged" ? "light dark" : expected === "adaptive" ? "dark" : expected,
    );
  }
});
