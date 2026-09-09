# Shared application and artifact themes

Status: complete
Publication: local only
Source: [RFC 21, revision 1](../../docs/rfc/21_shared-application-and-artifact-themes.rfc.md), including the Settings decision confirmed on 2026-09-09.
Review: [Unversioned review](../../docs/rfc/21_shared-application-and-artifact-themes.review-unversioned.md), answered by revision 1; the revised draft has not received a separate independent review.
Breakdown: confirmed; all four tickets implemented.

## Scope

Give the reader one browser-owned System, Light, or Dark preference. Put the
sun/moon toggle and a small Appearance Settings entry at the upper right of
the hub and reading view. Keep driver settings in the composer. Compatible
artifacts and annotation controls follow the applicable frame policy;
fixed-theme artifacts retain their authored appearance.

Kevin confirmed Settings placement, ticket scope, implementation, and test seams.
All four tickets are complete on the isolated implementation branch.

## Tickets

| Ticket | Blocked by | End-to-end delivery |
|---|---|---|
| [01 - Choose and retain the hub appearance](issues/01-hub-appearance.md) | None | The hub follows System by default and offers persistent, accessible appearance controls. |
| [02 - Use the same appearance throughout the reading view](issues/02-reading-view-appearance.md) | 01 | Reading, chat, comparison, and Settings share the preference across navigation and tabs. |
| [03 - Synchronize artifacts and annotation controls without losing edits](issues/03-artifact-theme-synchronization.md) | 02 | Both document-frame locations apply the version's policy in place and preserve reading, editing, and saving. |
| [04 - Author and verify adaptive reading artifacts](issues/04-adaptive-artifact-authoring.md) | 03 | Authors have a verified reusable example and guidance that produces readable, serialization-safe adaptive documents. |

01 establishes the shared preference through a working hub, including the
native-frame prerequisite probe. 02 consumes that preference in the reading
view and supplies the live controls that 03 uses for document switching.
04 enables adaptive authoring only after the integrated runtime is verified.
No separate prefactoring ticket is needed: additive shared ownership lands
with its first consumer. Each ticket stays independently verifiable and green.
Hub-only support after 01 and application-only support after 02 are intermediate
delivery states; completion of the feature requires all four tickets.

## Completion rules

Read the source RFC and governing ADRs before pickup. Each ticket owns its
deterministic tests, applicable browser evidence, current contract updates,
and repository check/build gates. There is no deferred testing ticket.
Name the browser and version used; keep generated evidence in ignored artifacts.
Use the RFC's fixed-document oracle for switching. Generated-document evidence
in 04 evaluates authoring quality, not harness transport.

Existing bounded probes inform the work but do not satisfy integrated
application, contrast, first-paint, or save/reopen acceptance criteria.
Keep appearance browser-local, immutable versions intact, and artifacts
outside the application's origin. Do not add record writes, model turns,
theme messages, cross-machine sync, arbitrary recoloring, or serializer
heuristics. Preserve unrelated working-tree changes.

## RFC coverage

| Contract or review response | Ticket ownership |
|---|---|
| Preference ownership, state machine, storage failures, System restoration; Note 5 | 01; cross-shell proof in 02 |
| Sun/moon action, Settings decision, first paint, access and responsive layouts | 01 hub; 02 reading view |
| Application palettes, Settings vocabulary, all header states; Notes 1 and 3 | 01 hub; 02 reading, chat, comparison |
| Native prerequisite and correct specification references; F3 | 01 probe; 03 integrated policy |
| Inert version-specific declaration parsing; Note 2 | 03 |
| Fixed/adaptive/unmanaged policies and changed inspection behavior; F2 | 03 |
| Annotation palette, mixed-background verification, sandbox and message boundary | 03 |
| Snapshot invariance, retained edits, positive/negative graphics controls; F1 | 03 runtime; 04 authoring |
| Current design contracts and source comments; Note 4 | Each owning ticket, with authoring guidance in 04 |
| Deterministic self-contained behaviour reference; Note 6 | 01 hub samples; 02 application samples; 03 isolated annotation samples |
| Reusable example, generated-document evidence, standalone behavior | 04 |

## Comments

Slicing uses the source exploration and bounded browser evidence from RFC
drafting, review, and revision, plus the current product vocabulary and ADRs.
Those observations describe existing boundaries, not proof of this feature.
All four issues are complete locally. Nothing has been published to a shared tracker.
