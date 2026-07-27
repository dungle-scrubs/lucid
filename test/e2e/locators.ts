import type { FrameLocator, Locator, Page } from "@playwright/test";

/**
 * Every way the suite reaches into the product, in one place.
 *
 * Two rules, and they exist because of two real failures rather than a
 * preference for tidiness (D-021):
 *
 * A test that finds its target by `placeholder^="Message the agent"` is coupled
 * to a sentence somebody will reword - the placeholder is UI copy, and copy
 * changes without anybody thinking about tests. The same goes for a class name,
 * which changes when a style does.
 *
 * `Meta+w` hardcodes macOS. The same test on Linux drives a chord the product
 * never sees, and passes by asserting nothing happened. `mod()` asks the
 * platform.
 *
 * Factories rather than constants so a hook can take a parameter (a tab by its
 * label, a row by its id) without every call site rebuilding a selector string.
 */

/** The platform's own modifier: `Meta` on darwin, `Control` everywhere else. */
export const mod = (): "Meta" | "Control" => (process.platform === "darwin" ? "Meta" : "Control");

/** A chord in the platform's terms - `chord("w")` is ⌘W here and Ctrl+W there. */
export const chord = (key: string): string => `${mod()}+${key}`;

/** The one place a `data-test` selector is spelled. */
const hook = (name: string): string => `[data-test="${name}"]`;

/** A hook, optionally narrowed by an attribute the product sets on it. */
const hookWith = (name: string, attr: string, value: string): string =>
  `[data-test="${name}"][${attr}="${value}"]`;

export const on = (root: Page | FrameLocator) => ({
  // --- the composer and the record -------------------------------------------
  /** The message box. Was `textarea[placeholder^="Message the agent"]`. */
  messageInput: (): Locator => root.locator(hook("message-input")),
  sendMessage: (): Locator => root.locator(hook("send-message")),
  /** The annotation note. Was `textarea[placeholder^="What should change here?"]`. */
  annotationNote: (): Locator => root.locator(hook("annotation-note")),
  addToQueue: (): Locator => root.locator(hook("add-to-queue")),
  sendQueue: (): Locator => root.locator(hook("send-queue")),
  fork: (): Locator => root.locator(hook("fork")),
  approve: (): Locator => root.locator(hook("approve")),
  reopen: (): Locator => root.locator(hook("reopen")),
  annotation: (): Locator => root.locator(hook("annotation")),
  orphan: (): Locator => root.locator(hook("orphan")),
  unsentMessage: (): Locator => root.locator(hook("unsent-message")),
  notice: (): Locator => root.locator(hook("notice")),
  agentWorking: (): Locator => root.locator(hook("agent-working")),
  surfaceUpdating: (): Locator => root.locator(hook("surface-updating")),
  reconnecting: (): Locator => root.locator(hook("reconnecting")),
  threadViewport: (): Locator => root.locator(hook("thread-viewport")),
  listenerLine: (mode?: string): Locator =>
    root.locator(
      mode === undefined ? hook("listener-line") : hookWith("listener-line", "data-mode", mode),
    ),

  // --- the shell -------------------------------------------------------------
  shellTab: (): Locator => root.locator(hook("shell-tab")),
  activeShellTab: (): Locator => root.locator(hookWith("shell-tab", "data-active", "true")),
  tabAdd: (): Locator => root.locator(hook("tab-add")),
  tabClose: (): Locator => root.locator(hook("tab-close")),
  tabAttention: (kind?: string): Locator =>
    root.locator(
      kind === undefined ? hook("tab-attention") : hookWith("tab-attention", "data-kind", kind),
    ),
  pickerRow: (): Locator => root.locator(hook("picker-row")),
  pickerProject: (): Locator => root.locator(hook("picker-project")),
  projectsDrawer: (): Locator => root.locator(hook("projects-drawer")),
  drawerProject: (): Locator => root.locator(hook("drawer-project")),
  addFolderType: (): Locator => root.locator(hook("add-folder-type")),
  addFolderPath: (): Locator => root.locator(hook("add-folder-path")),
  addFolderPathAdd: (): Locator => root.locator(hook("add-folder-path-add")),
  themeToggle: (): Locator => root.locator(hook("theme-toggle")),
  allOpen: (): Locator => root.locator(hook("all-open")),
});

/**
 * Selectors this file does NOT own, and why.
 *
 * `[data-lucid-id="…"]` addresses elements inside the ARTIFACT, which is a
 * document Lucid did not author - the id comes from the fixture, not from the
 * product, so a factory here would just be indirection over the fixture's own
 * vocabulary.
 */
export const inArtifact = (surface: FrameLocator) => ({
  byLucidId: (id: string): Locator => surface.locator(`[data-lucid-id="${id}"]`),
});
