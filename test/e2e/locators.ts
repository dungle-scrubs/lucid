import type { FrameLocator, Locator, Page } from "@playwright/test";

/**
 * Every way the suite reaches into the product, in one place.
 *
 * Two rules, and both come from a real failure rather than a preference for
 * tidiness (D-021):
 *
 * A test that finds its target by `placeholder^="Message the agent"` is coupled
 * to a sentence somebody will reword - the placeholder is UI copy, and copy
 * changes without anybody thinking about a test. A class name is the same
 * problem wearing a style's clothes.
 *
 * `Meta+w` hardcodes macOS. The same test on Linux drives a chord the product
 * never receives, and passes by asserting nothing happened. `mod()` asks.
 *
 * Generated from the hooks in use (147 of them) rather than written by
 * hand, so the list cannot fall behind the suites. `scripts/check-locators.ts`
 * rejects a raw `[data-test=` outside this file.
 */

/** The platform's own modifier: `Meta` on darwin, `Control` everywhere else. */
export const mod = (): "Meta" | "Control" => (process.platform === "darwin" ? "Meta" : "Control");

/** A chord in the platform's terms - `chord("w")` is ⌘W here and Ctrl+W there. */
export const chord = (key: string): string => `${mod()}+${key}`;

/**
 * The one place a `data-test` selector is spelled.
 *
 * Exported because some targets are a hook NARROWED by a state attribute the
 * product sets - `[data-test="shell-tab"][data-active="true"]` - and inventing
 * a factory per state would be a worse vocabulary than composing two things
 * that already exist.
 */
export const hook = (name: string): string => `[data-test="${name}"]`;

/** Hooks bound to a page, a frame, or a locator - scoping to a sub-tree
 *  ("the add-folder button INSIDE the drawer") is how several suites
 *  disambiguate a hook the product renders in more than one place. */
export const on = (root: Page | FrameLocator | Locator) => ({
  addFolder: (): Locator => root.locator(hook("add-folder")),
  addFolderError: (): Locator => root.locator(hook("add-folder-error")),
  addFolderPath: (): Locator => root.locator(hook("add-folder-path")),
  addFolderPathAdd: (): Locator => root.locator(hook("add-folder-path-add")),
  addFolderResult: (): Locator => root.locator(hook("add-folder-result")),
  addFolderType: (): Locator => root.locator(hook("add-folder-type")),
  addToQueue: (): Locator => root.locator(hook("add-to-queue")),
  agentWorking: (): Locator => root.locator(hook("agent-working")),
  awaitingAck: (): Locator => root.locator(hook("awaiting-ack")),
  allOpen: (): Locator => root.locator(hook("all-open")),
  annotation: (): Locator => root.locator(hook("annotation")),
  annotationChip: (): Locator => root.locator(hook("annotation-chip")),
  annotationNote: (): Locator => root.locator(hook("annotation-note")),
  annotationThumb: (): Locator => root.locator(hook("annotation-thumb")),
  answer: (): Locator => root.locator(hook("answer")),
  answerAnchor: (): Locator => root.locator(hook("answer-anchor")),
  answerBlocked: (): Locator => root.locator(hook("answer-blocked")),
  approve: (): Locator => root.locator(hook("approve")),
  approveWrap: (): Locator => root.locator(hook("approve-wrap")),
  cancelEdit: (): Locator => root.locator(hook("cancel-edit")),
  cancelPicks: (): Locator => root.locator(hook("cancel-picks")),
  choice: (): Locator => root.locator(hook("choice")),
  contextRing: (): Locator => root.locator(hook("context-ring")),
  copyUnsent: (): Locator => root.locator(hook("copy-unsent")),
  createAddProject: (): Locator => root.locator(hook("create-add-project")),
  createAttendHint: (): Locator => root.locator(hook("create-attend-hint")),
  createAuthoring: (): Locator => root.locator(hook("create-authoring")),
  createBlocked: (): Locator => root.locator(hook("create-blocked")),
  createClose: (): Locator => root.locator(hook("create-close")),
  createDialog: (): Locator => root.locator(hook("create-dialog")),
  createEffort: (): Locator => root.locator(hook("create-effort")),
  createError: (): Locator => root.locator(hook("create-error")),
  createFailedTail: (): Locator => root.locator(hook("create-failed-tail")),
  createHarness: (): Locator => root.locator(hook("create-harness")),
  createModel: (): Locator => root.locator(hook("create-model")),
  createName: (): Locator => root.locator(hook("create-name")),
  createNameError: (): Locator => root.locator(hook("create-name-error")),
  createOverlay: (): Locator => root.locator(hook("create-overlay")),
  createProject: (): Locator => root.locator(hook("create-project")),
  createProjectError: (): Locator => root.locator(hook("create-project-error")),
  createProjectPath: (): Locator => root.locator(hook("create-project-path")),
  createProjectPathAdd: (): Locator => root.locator(hook("create-project-path-add")),
  createPrompt: (): Locator => root.locator(hook("create-prompt")),
  createSubmit: (): Locator => root.locator(hook("create-submit")),
  createTimeout: (): Locator => root.locator(hook("create-timeout")),
  createTitle: (): Locator => root.locator(hook("create-title")),
  createUsageLimit: (): Locator => root.locator(hook("create-usage-limit")),
  customAnswer: (): Locator => root.locator(hook("custom-answer")),
  defer: (): Locator => root.locator(hook("defer")),
  deliveryState: (): Locator => root.locator(hook("delivery-state")),
  diffBar: (): Locator => root.locator(hook("diff-bar")),
  diffCount: (): Locator => root.locator(hook("diff-count")),
  diffDone: (): Locator => root.locator(hook("diff-done")),
  discard: (): Locator => root.locator(hook("discard")),
  discardDraft: (): Locator => root.locator(hook("discard-draft")),
  discardUnsent: (): Locator => root.locator(hook("discard-unsent")),
  drawerLower: (): Locator => root.locator(hook("drawer-lower")),
  editNote: (): Locator => root.locator(hook("edit-note")),
  editQueued: (): Locator => root.locator(hook("edit-queued")),
  enterDiff: (): Locator => root.locator(hook("enter-diff")),
  fadeAttention: (): Locator => root.locator(hook("fade-attention")),
  foldToggle: (): Locator => root.locator(hook("fold-toggle")),
  foldedText: (): Locator => root.locator(hook("folded-text")),
  fork: (): Locator => root.locator(hook("fork")),
  freeText: (): Locator => root.locator(hook("free-text")),
  groupLabel: (): Locator => root.locator(hook("group-label")),
  gotoIncomplete: (): Locator => root.locator(hook("goto-incomplete")),
  harnessLine: (): Locator => root.locator(hook("harness-line")),
  imageChip: (): Locator => root.locator(hook("image-chip")),
  lbCounter: (): Locator => root.locator(hook("lb-counter")),
  lbNext: (): Locator => root.locator(hook("lb-next")),
  lbPrev: (): Locator => root.locator(hook("lb-prev")),
  lightbox: (): Locator => root.locator(hook("lightbox")),
  listenerLine: (): Locator => root.locator(hook("listener-line")),
  messageInput: (): Locator => root.locator(hook("message-input")),
  modeTerm: (): Locator => root.locator(hook("mode-term")),
  newArtifact: (): Locator => root.locator(hook("new-artifact")),
  newerVersion: (): Locator => root.locator(hook("newer-version")),
  notice: (): Locator => root.locator(hook("notice")),
  orphan: (): Locator => root.locator(hook("orphan")),
  palette: (): Locator => root.locator(hook("palette")),
  paletteAddFolder: (): Locator => root.locator(hook("palette-add-folder")),
  paletteInput: (): Locator => root.locator(hook("palette-input")),
  paletteOverlay: (): Locator => root.locator(hook("palette-overlay")),
  panelToggle: (): Locator => root.locator(hook("panel-toggle")),
  positionalAnchor: (): Locator => root.locator(hook("positional-anchor")),
  pendingTargets: (): Locator => root.locator(hook("pending-targets")),
  picker: (): Locator => root.locator(hook("picker")),
  pickerFilter: (): Locator => root.locator(hook("picker-filter")),
  pickerProject: (): Locator => root.locator(hook("picker-project")),
  pickerRow: (): Locator => root.locator(hook("picker-row")),
  pinRegion: (): Locator => root.locator(hook("pin-region")),
  recentRow: (): Locator => root.locator(hook("recent-row")),
  previewFrame: (): Locator => root.locator(hook("preview-frame")),
  previewText: (): Locator => root.locator(hook("preview-text")),
  qa: (): Locator => root.locator(hook("qa")),
  qaAnswer: (): Locator => root.locator(hook("qa-answer")),
  qaThumb: (): Locator => root.locator(hook("qa-thumb")),
  question: (): Locator => root.locator(hook("question")),
  questionDrawer: (): Locator => root.locator(hook("question-drawer")),
  questionRef: (): Locator => root.locator(hook("question-ref")),
  questionReopen: (): Locator => root.locator(hook("question-reopen")),
  questionTab: (): Locator => root.locator(hook("question-tab")),
  questionText: (): Locator => root.locator(hook("question-text")),
  queuedAnnotation: (): Locator => root.locator(hook("queued-annotation")),
  quickReply: (): Locator => root.locator(hook("quick-reply")),
  reask: (): Locator => root.locator(hook("reask")),
  removeQueued: (): Locator => root.locator(hook("remove-queued")),
  reason: (): Locator => root.locator(hook("reason")),
  reconnecting: (): Locator => root.locator(hook("reconnecting")),
  reopen: (): Locator => root.locator(hook("reopen")),
  resolvedBar: (): Locator => root.locator(hook("resolved-bar")),
  resumeCopy: (): Locator => root.locator(hook("resume-copy")),
  resumeCopyLabel: (): Locator => root.locator(hook("resume-copy-label")),
  retryUnsent: (): Locator => root.locator(hook("retry-unsent")),
  revert: (): Locator => root.locator(hook("revert")),
  revertWhy: (): Locator => root.locator(hook("revert-why")),
  reviewBar: (): Locator => root.locator(hook("review-bar")),
  saveEdit: (): Locator => root.locator(hook("save-edit")),
  scrollBottom: (): Locator => root.locator(hook("scroll-bottom")),
  sectionLink: (): Locator => root.locator(hook("section-link")),
  selectionEffort: (): Locator => root.locator(hook("selection-effort")),
  selectionModel: (): Locator => root.locator(hook("selection-model")),
  selectionPickers: (): Locator => root.locator(hook("selection-pickers")),
  sendMessage: (): Locator => root.locator(hook("send-message")),
  sendQueue: (): Locator => root.locator(hook("send-queue")),
  sessionOpenCopy: (): Locator => root.locator(hook("session-open-copy")),
  sessionResumeCopy: (): Locator => root.locator(hook("session-resume-copy")),
  sessionRow: (): Locator => root.locator(hook("session-row")),
  sessionsList: (): Locator => root.locator(hook("sessions-list")),
  sessionsRefresh: (): Locator => root.locator(hook("sessions-refresh")),
  shellTab: (): Locator => root.locator(hook("shell-tab")),
  shellTabbar: (): Locator => root.locator(hook("shell-tabbar")),
  skip: (): Locator => root.locator(hook("skip")),
  surfaceUpdating: (): Locator => root.locator(hook("surface-updating")),
  tabAdd: (): Locator => root.locator(hook("tab-add")),
  tabAttention: (): Locator => root.locator(hook("tab-attention")),
  tabChat: (): Locator => root.locator(hook("tab-chat")),
  tabClose: (): Locator => root.locator(hook("tab-close")),
  tabGroup: (): Locator => root.locator(hook("tab-group")),
  tabSessions: (): Locator => root.locator(hook("tab-sessions")),
  tabbarFadeLeft: (): Locator => root.locator(hook("tabbar-fade-left")),
  tabbarFadeRight: (): Locator => root.locator(hook("tabbar-fade-right")),
  targetChip: (): Locator => root.locator(hook("target-chip")),
  themeToggle: (): Locator => root.locator(hook("theme-toggle")),
  threadViewport: (): Locator => root.locator(hook("thread-viewport")),
  thumb: (): Locator => root.locator(hook("thumb")),
  toggleTargets: (): Locator => root.locator(hook("toggle-targets")),
  unsentMessage: (): Locator => root.locator(hook("unsent-message")),
  unsentMessages: (): Locator => root.locator(hook("unsent-messages")),
  version: (): Locator => root.locator(hook("version")),
  versionView: (): Locator => root.locator(hook("version-view")),
  versionViewExit: (): Locator => root.locator(hook("version-view-exit")),
  warning: (): Locator => root.locator(hook("warning")),
});

/**
 * The tooltip popup, wherever Base UI portalled it.
 *
 * Not a `data-test` hook and not on `on()`: the popup is not rendered by the
 * chrome at all - `TooltipContent` portals it to `<body>`, outside the tree its
 * trigger lives in, so it cannot be reached by scoping to the thing it
 * describes. `data-slot` is shadcn's own contract for the vendored parts
 * (client/chrome/ui/tooltip.tsx sets it), which is why this is not the
 * class-coupled selector it looks like.
 */
export const tooltipPopup = (root: Page): Locator => root.locator('[data-slot="tooltip-content"]');

/**
 * Selectors this file does NOT own.
 *
 * `[data-lucid-id="…"]` addresses elements inside the ARTIFACT, a document
 * Lucid did not author: the id comes from the fixture, so a factory here would
 * be indirection over the fixture's own vocabulary.
 */
export const inArtifact = (surface: FrameLocator) => ({
  byLucidId: (id: string): Locator => surface.locator(`[data-lucid-id="${id}"]`),
});
