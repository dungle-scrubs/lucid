# Conversation panel visibility

Status: in progress
Publication: local only

## Agreed behavior

The conversation panel starts collapsed in each new browser view. The CLI can explicitly select open or closed for that view's initial state. A button collapses the panel fully out of view with a transition to the right; a visible control opens it again.

Visibility belongs to the browser view. It is not an artifact property or a saved conversation preference. This lets Kevin read and annotate an artifact in a ChatGPT desktop browser panel while continuing the conversation in ChatGPT, and optionally open Lucid's conversation panel in a regular browser.

## Implementation ticket

1. [Make the conversation panel collapsible with CLI initial state](issues/01-conversation-panel-visibility.md). Blocked by: none. Delivers the browser controls, collapsed default, and CLI selection as one complete behavior.

Machine-made slicing decision: one ticket keeps initialization and the manual toggle under one view-state contract. Kevin requested tickets for later while another map is being implemented. No implementation starts as part of this handoff.

## Pickup prerequisite

When Kevin schedules this work, follow the repository's RFC and independent review workflow before implementation. These tickets preserve the agreed requirements; they do not represent an approved RFC. Recheck the browser and CLI contracts after the ongoing work lands. There is no known functional dependency on that work, so no issue dependency is invented for the scheduling preference.

## Scope

This serves the existing artifact reading and annotation workflow and holds product scope. Live CLI control of an already loaded view, automatic detection of ChatGPT, and visibility stored on artifacts or conversations are outside this effort. Explicit initial-state selection covers both browser environments.
