---
number: 17
title: "Conversation panel visibility"
type: feature
status: Accepted
author: Kevin Frilot
date: 2026-09-08
revision: 2
---

# RFC-17: Conversation panel visibility

## Abstract

Lucid's conversation panel currently occupies space whenever an artifact is open. A person reading an artifact while continuing the conversation in ChatGPT needs to recover that space. Each new browser view will start with the conversation collapsed, with a reversible browser control and an explicit CLI initializer. Visibility belongs only to the current view and does not alter the conversation record.

## Introduction

The [selected ticket](../../.scratch/conversation-panel-visibility/issues/01-conversation-panel-visibility.md) establishes the behavior. Kevin selected implementation and confirmed the test seams and CLI spelling on 2026-09-08. This RFC completes its pickup prerequisite before product code changes.

Fit check: Kevin uses Lucid to read and annotate agent artifacts, sometimes inside a ChatGPT browser panel. Collapsing an unused conversation panel serves that existing purpose and holds scope. Automatic host detection, persisted visibility preferences, live CLI control of already loaded views, and changes to driver ownership are excluded.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

A **view** is one loaded browser document displaying Lucid. The **conversation panel** contains the transcript and composer. **Initial visibility** is the state supplied when that view loads. Record, artifact, and driver retain the definitions in [CONTEXT](../../CONTEXT.md).

## Motivation

The current browser view always mounts two visible panes, arranged side by side above 900px and stacked below it. Its existing width and document-height controls resize those panes but cannot remove the conversation. Removing and recreating the conversation to hide it would risk composer state and subscriptions. A server-wide setting would also affect other views using the same server.

## Design

### CLI and view URL

`lucid2 serve [conversation] [--conversation-panel <open|closed>]` MUST print a link to the selected conversation. The omitted conversation remains `demo`, preserving the current example link. The CLI MUST NOT create a record as a side effect of selecting it. This extends the existing server command; it does not add an automatic browser launcher.

An explicit option MUST be encoded as the `conversation-panel` query parameter on the printed conversation URL. With no option, the parameter SHOULD be omitted and the browser default applies. The initial choice MUST NOT be passed to the server as a global setting, written to browser storage, or stored with a record.

The parser MUST accept the option before or after the optional conversation argument. It MUST reject missing, invalid, repeated, or unknown options and extra positionals with clear usage guidance before starting a server. Explicit values are lowercase `open` and `closed`. Help MUST describe the default and both values. The documented no-argument `serve` invocation remains valid; formerly ignored invalid arguments now fail. Conversation arguments MUST pass the existing `validConversationId` rule. Help and user documentation MUST include examples for both explicit states. Existing command error/reporting conventions apply.

The URL formatter MUST percent-encode the conversation path segment. The browser MUST treat exactly one `conversation-panel=open` value as open; missing, invalid, or duplicate values MUST initialize closed. An explicit `closed` initializes closed. Malformed URL choices are harmless view input, not record errors.

The app MUST read initial visibility synchronously in the first render, before painting the panel. Later artifact/version path replacements MUST preserve the query string. Manual toggles MUST NOT rewrite the initializer or establish a preference for new views. Reloading initializes again from that URL. Navigating to another independently loaded view initializes that view independently. Existing saved-version links that open a new view carry no initializer and start closed. `formatRoute` remains path-only; the history replacement caller preserves the current query and fragment.

### Browser controls and state

A named toggle MUST remain in the document header in loaded, empty, missing-artifact, unsaved, historical, comparison, and connection-error states. It MUST expose `aria-expanded` and `aria-controls` for the conversation panel. Its accessible name MUST change between `Show conversation` and `Hide conversation`. A compact icon with a matching title is acceptable where the header is narrow. One shared control MUST be used by all five header branches, including the empty header when a token expires before an artifact loads.

The panel subtree and its subscriptions MUST remain mounted while hidden. Visibility changes MUST NOT change the artifact iframe identity, conversation identity, composer contents, attachments, pending notes, note drafts, or unsaved edits. New transcript messages, driver state, saved versions, and artifact revisions MUST NOT reset visibility. Opening the panel MUST restore access to the same transcript and composer.

Visibility state MUST have no storage or protocol effects. Existing persisted conversation width is independent; hiding MUST NOT overwrite it. Reopening SHOULD restore the current view's prior pane sizes, clamped to available space by the existing layout rules.

### Layout, focus, and motion

Collapsing MUST move the whole conversation panel to the right, remove its layout allocation and divider, and let the document use the released space. The same rightward motion applies to the stacked layout. A clipped layout container MUST prevent the moving panel from creating horizontal page overflow. Clipping and any wrapper MUST preserve the resize handlers' geometry measurements and access to open driver menus. The stacked document MUST use the full available height while collapsed without overwriting its prior height share. Crossing the 900px breakpoint MUST preserve visibility and apply the new geometry.

The panel displacement and release of layout space SHOULD transition together over about 180ms. The divider disappears immediately. CSS establishes the final layout without an event or timer. Comparison and header content MAY reflow during resizing; note editors MUST retain identity, draft, and focus, but their screen coordinates need not stay fixed. Existing transcript scroll behavior remains in force; toggling MUST NOT explicitly reset scroll position. Hidden content MUST be inert and absent from the accessibility tree immediately when collapse is requested, including during the transition. The collapse action MUST place focus on the visible toggle before removing access to the panel. The reopen action SHOULD leave focus on that toggle so normal Tab navigation can enter the restored panel. The hidden divider MUST NOT remain focusable or respond to resize actions.

With reduced motion, transitions MUST be disabled and both final states MUST remain identical. No timer or transition-end event may be required to restore usability. Rapid repeated toggles MUST settle at the latest requested state.

## State Machine

| Current state | Input | Result |
|---|---|---|
| Uninitialized | One explicit `open` value | Open before first paint |
| Uninitialized | Missing, closed, invalid, or repeated value | Closed before first paint |
| Open | Browser toggle | Closed; focus stays on the visible toggle |
| Closed | Browser toggle | Open; existing panel state remains available |
| Either | Conversation or artifact update | Same visibility |
| Either | Reload or independently loaded view | Initialize from that document's URL |

The logical state is open or closed. Animation progress is a rendering detail, not a third application state. There are no timeout transitions and no remote visibility command.

## Error Handling

Invalid CLI input MUST produce help/error text identifying the invalid argument and MUST NOT start the server. This uses the existing `MappedCommand` help result and CLI reporting behavior; no new protocol error code is introduced.

Invalid URL input MUST fall back to closed. Missing or damaged records and invalid server tokens MUST retain the visible toggle so panel access is not tied to a successful artifact load. A failed transition or disabled animation MUST NOT trap focus or leave the layout waiting for an event. Existing server-start errors retain their present recovery behavior.

## Security Considerations

The query parameter controls presentation only. It MUST NOT affect record authorization, frame tokens, attach secrets, driver lifecycle, or iframe sandbox permissions. Hidden is not a confidentiality guarantee: the mounted transcript still exists in the local browser document. Only fixed enumerated choices are accepted; values MUST NOT become arbitrary HTML or CSS. CLI target selection MUST remain a URL path operation and MUST NOT resolve a filesystem path.

## Alternatives Considered

- Persist visibility with the conversation: rejected because two views of the same record can need different layouts.
- Detect ChatGPT automatically: rejected because explicit view initialization covers the need without host-specific behavior.
- Unmount the panel: rejected because visibility must preserve composer and conversation state.
- Make CLI flags change the server default: rejected because one server serves many independent views.
- Keep the panel as an overlay while closed: rejected because its controls must be unreachable and its layout space released.

## Implementation Plan

One existing ticket remains the delivery unit. No unrelated hub or comparison feature is included in its commit.

The confirmed test seams are:

1. `mapSubcommand` / `dispatch` and the view URL formatter: default command, explicit values, invalid arguments, and the exact target link. Pure parsing and command orchestration tests attach here without starting a model.
2. A browser-only visibility module: initialization, isolated view instances, and manual toggle state across ordinary rerenders. The UI uses the same interface as its deterministic tests.
3. A shared exported panel control and browser-only state module provide deterministic initialization, focus, and mount-retention checks without importing the self-mounting `App`. The real browser provides layout and motion evidence; JSDOM is not a geometry oracle. The rendered reading view: native keyboard and pointer controls, accessibility state, pane geometry, reduced motion, and retention of composer/annotation/edit state while updates arrive.

Implement behavior with one failing test at a time. Typecheck during the loop. Frontend layout and integration receive focused browser checks after construction. Run the full project check and binary build at the end. Review the task diff on reuse, quality, efficiency, and spec fidelity, then apply the findings before committing.

Verify 390, 768, and 1440px with both initial states and after manual toggles. Inspect a captured intermediate collapse state to establish rightward motion and no horizontal overflow. Verify no expanded-panel flash from the initial closed render. Exercise a new view of the same conversation to establish isolation. Run the generated CLI link in the browser and prove an artifact revision does not reset a manual choice.

On completion, extract the current contract into the README and reading-view docs. Remove the completed proposal/review/ticket from the active working tree after preserving the implementation history in Git. Rollback is the feature commit's inverse; no record migration is needed.

## Open Questions

None. Kevin confirmed the seams and CLI spelling. Design recommendations in this RFC implement the already selected behavior and remain subject to independent review. The existing width and comparison changes in the shared checkout are unrelated work and will be preserved.

## References

### Normative

- [Selected spec](../../.scratch/conversation-panel-visibility/spec.md) - scope and pickup prerequisite.
- [Implementation ticket](../../.scratch/conversation-panel-visibility/issues/01-conversation-panel-visibility.md) - acceptance criteria.
- [Context](../../CONTEXT.md) - product purpose and vocabulary.
- [Document evidence](../adr/0007-document-edits-preserve-evidence.md) - edits and versions remain intact.
- [Browser authority](../adr/0008-browser-and-agent-content-have-separate-authority.md) - browser and artifact isolation.

### Informative

- [Reading-view design](../design.md) - current pane behavior.
- [CLI serve command](../../src/cli/serve.ts) - current printed URL and server lifecycle.

## Revision 2 decisions

Independent review: `opus-5@claude`, [revision 1 report](17_conversation-panel-visibility.review-revision-1.md). F-01, F-02, F-04 through F-12 are addressed above. F-03 correctly identifies five header branches; its claim that an empty/error combination has no header is inaccurate because it renders the empty header. That existing header receives the shared control. No new error branch is needed. All changes clarify the selected scope.
