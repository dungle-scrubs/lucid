# Make the conversation panel collapsible with CLI initial state

Status: in progress
Blocked by: none

## What to build

Open a Lucid browser view with its conversation panel collapsed by default. Provide a button that slides the panel fully out of view to the right and a visible control that opens it again. The document can use the released space.

Allow the CLI to explicitly select open or closed as the initial conversation-panel state of the view it opens or links to. This is a view setting, independent of the artifact and conversation record. After initialization, the person controls the panel with the browser toggle.

## Acceptance criteria

- [ ] A new view without an explicit CLI selection starts collapsed in both a regular browser and a browser panel opened from ChatGPT. There is no flash of the expanded panel before the default takes effect.
- [ ] The CLI accepts an explicit open or closed initial state and carries it to the intended browser view. Help and user documentation describe the option, its default, and examples for both states. Invalid option values receive a clear error.
- [ ] The selection applies to the target view only. It does not change other open views, artifact bytes or versions, conversation metadata, or the conversation log. Manual toggles do not establish a default for future views.
- [ ] Collapse moves the entire conversation panel off to the right and removes its occupied space and divider. A visible, named reopen control remains usable. Opening restores access to the transcript and composer.
- [ ] Opening and closing are reversible without reloading the view, losing composer text, unsaved document edits, or pending annotations. The existing conversation continues while its panel is hidden.
- [ ] Subsequent conversation updates and artifact revisions preserve the person's current toggle choice. The CLI selection is an initializer, not an ongoing command to reopen or close the view.
- [ ] Both controls work with a keyboard and expose the panel's expanded state. Hidden panel controls cannot receive focus. Collapsing leaves focus on a visible control. Reduced-motion preferences are respected.
- [ ] Verify collapsed and expanded states at 390, 768, and 1440 pixels. Controls remain reachable, the document remains usable, and the transition introduces no horizontal page overflow.
- [ ] Deterministic checks cover default, explicit open, explicit closed, view isolation, and manual toggles surviving updates. Browser verification confirms the transition and preservation of existing reading, editing, annotation, and conversation behavior. The repository's full check and binary build pass.

## Pickup prerequisite

Deferred at Kevin's request while another map is being implemented. Start only when this work is selected. Complete the repository's RFC and independent review workflow before changing product code; recheck the current browser and CLI contracts then.
