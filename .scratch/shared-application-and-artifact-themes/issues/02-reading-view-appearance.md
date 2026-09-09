# 02 - Use the same appearance throughout the reading view

Status: draft
Blocked by: 01
Publication: local only
Source: RFC 21, revision 1 - Controls and application appearance; Preference ownership and storage; Annotation controls, edits, and comparisons; Settings decision confirmed 2026-09-09.

## What to build

Opening an artifact carries the hub's appearance choice into the reading view,
chat, comparison UI, and Settings. The reading view offers the same sun/moon
action and an adjacent Settings entry, including when chat is hidden. The
existing composer Settings also links to Appearance; driver settings stay
in the composer.

Use the preference owner delivered by 01. This slice completes application
appearance; document-frame synchronization follows in 03.

## Acceptance criteria

- [ ] Direct artifact entry applies the stored or system appearance before first styled paint using the shared parsing rules. Hub-to-artifact navigation, artifact changes, and cross-tab updates use the same preference and persistence behavior.
- [ ] The upper-right toggle and adjacent Appearance entry stay reachable with chat open or hidden, no document, a missing artifact, read-only/disconnected state, and unsaved edits. Appearance applies immediately without Save settings or a valid driver session.
- [ ] Toggle action and accessible names match the hub. The normal, inverted Save/Discard, and disconnected headers each retain legible foregrounds, visible focus, and nonoverlapping controls at 390, 768, and 1440px.
- [ ] Reading, chat, comparison UI, portals, dialogs, errors, empty states, selection, disabled controls, and focus states have complete light/dark semantic palettes. Preserve visual hierarchy and accent roles. Settings resolves to the reading view's vocabulary consistently across appearances.
- [ ] Switching application appearance preserves composer input, dirty edits, pending notes, focus, selections, scroll positions, document mode, and comparison recovery. It causes no document reload, version creation, agent turn, or preference write outside browser storage.
- [ ] Deterministic tests exercise reading-view controls, unavailable storage, shared state, and all header branches. Browser evidence covers first paint, hub/reading navigation, two tabs with different shells, System and opposite overrides, Follow system, hidden chat, all listed states, and all three widths.
- [ ] Application samples in the behaviour reference show explicit light/dark appearances independently of the OS. Current reading/comparison design contracts and light-only application comments match the delivered behavior. Repository check, build, reference-build, and whitespace gates pass.
