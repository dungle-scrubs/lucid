---
number: 21
title: "Shared application and artifact themes"
type: feature
status: Implemented
revision: 1
author: Kevin Frilot
date: 2026-09-08
---

# RFC-21: Shared application and artifact themes

Implemented revision 1. Responds to the
[unversioned cross-family review](21_shared-application-and-artifact-themes.review-unversioned.md).

## Abstract

Lucid's reading view is light-only, while an artifact can have a different
appearance. This RFC introduces a shared reading preference, defaulting to
System, with a sun/moon toggle at the upper right of the application bar.
Artifacts that declare support follow the selected appearance; fixed-theme
artifacts keep their appearance and undeclared artifacts keep their own styles
under a system-derived frame preference. Switching happens
in the browser without an agent turn or a new artifact version.

## Introduction

Lucid is a place for one person to read and mark up documents produced by
coding agents. The application and document are separate reading surfaces,
but their current theme choices have no shared user control. The existing
artifact guidance asks authors to support both appearances unless the user
requests a fixed theme; it does not establish a runtime contract.

The user confirmed these product decisions:

- Start with System and remember an explicit override across artifacts and
  browser restarts.
- Put a sun/moon control at the upper right of the application bar.
- Clicking switches immediately to the opposite appearance. Settings offers
  Follow system to restore automatic switching.
- Compatible artifacts follow the application. Fixed-theme artifacts keep
  their appearance.
- Open Appearance from a small Settings entry beside the theme toggle on
  the hub and reading view. Keep driver settings in the composer.

The scope covers the hub, reading view, chat, settings, comparison surfaces,
and Lucid's annotation controls inside documents. The artifact contract
covers HTML documents and their full-document inspection frames. It adds
one reading preference for the existing user and purpose: product scope
holds. The browser storage boundary and native CSS connection below are
technical proposals, not additional user-confirmed decisions.

Automatic recoloring of arbitrary HTML, artifact-to-application theme
commands, per-artifact reader overrides, account or cross-machine preference
sync, and changes to document branding are outside this RFC. They do not
serve the agreed single application preference. This RFC does not regenerate
existing versions or add a theme control inside authored documents.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

Existing terms retain their meanings from [CONTEXT](../../CONTEXT.md).

| Term | Meaning |
|---|---|
| Theme preference | The reader's choice: `system`, `light`, or `dark` |
| Resolved appearance | `light` or `dark`, computed from the preference and browser-reported system preference |
| Adaptive artifact | An HTML artifact declaring and implementing both appearances under this contract |
| Fixed-theme artifact | An HTML artifact declaring one authored appearance |
| Unmanaged artifact | An HTML artifact without a recognized declaration; its styles remain authored and its frame preference follows the system, independently of the application override |
| Application bar | The existing top header controls of the hub or artifact workspace |

## Motivation

Reading a dark artifact within a light application creates an avoidable
change in brightness. Application-only dark mode would help, but supported
artifacts can follow the same choice without involving the model at toggle
time. The reliability question has two parts: carrying the preference and
authoring readable palettes. The browser can carry the preference; authored
styles still require verification in both appearances.

Current evidence is the working tree, including concurrent local changes:
[app.css](../../src/server/client/app.css) explicitly describes a light-only
reading view; [hub.css](../../src/server/client/hub.css) and comparison styles
already contain dark tokens. [instrumentArtifact](../../src/server/client/instrument.ts)
adds annotation code, while its snapshot cleanup removes injected elements.
The reading frame and comparison inspection both use that instrumentation.
The review's bounded Chrome probe verified native switching and exposed the
snapshot and inspection differences addressed here. It was a fixture using
Lucid's instrumentation, not a full application test. The feature is unimplemented.

## Design

### Preference ownership and storage

One browser-owned theme module MUST own preference parsing, resolution,
persistence, subscriptions, and application to the page. The hub and reading
view MUST use the same module and storage key, `lucid.theme.v1`.
Storage access and media-query observation SHOULD be injectable dependencies,
following the storage seams in `layout.ts`, `input-recovery.ts`, and
`artifact-width.ts`, so tests can drive failures and preference changes.

The stored value is the literal string `system`, `light`, or `dark`. Missing
or invalid values resolve to `system`. System resolves from
`matchMedia("(prefers-color-scheme: dark)")`; no dark preference resolves to
light. An explicit light or dark choice MUST remain in force when the system
changes. Returning to System MUST immediately resolve against the current
system preference and resume following its changes.

The preference MUST persist in `localStorage` when available. Its boundary
is one browser profile and origin, including port. Normal browser restarts
retain it; cleared storage, private-session closure, or a different origin
can reset it. This is the platform's storage boundary, not a record setting.
See [localStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).

Same-origin tabs MUST converge on the latest stored preference. The writing
tab updates its own state immediately; other tabs respond to storage events
by reading the current value, including after key removal or storage clear.
On page restoration, the module MUST refresh stored and system state before
resuming normal updates. It MUST avoid writing a received storage change
back to storage. These rules account for the fact that the initiating tab
does not receive its own [storage event](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event).

Theme changes MUST NOT write the conversation log, driver preference,
artifact bytes, recovery drafts, or server configuration. They MUST remain
usable without an active agent, network response, or valid driver session.

### Controls and application appearance

The upper-right sun/moon button MUST act on the resolved appearance:

| Current appearance | Icon and accessible name | Result of activation |
|---|---|---|
| Light | Moon, “Switch to dark mode” | Save `dark` and apply dark |
| Dark | Sun, “Switch to light mode” | Save `light` and apply light |

This also applies while following System: the first click creates an explicit
override. The icon shows the available action. A tooltip or accessible
description SHOULD identify when the current choice follows System.

Settings MUST expose a separate Appearance control with Light, Dark, and
Follow system, identifying the selected preference. It applies immediately
and MUST NOT depend on the conversation's Save settings action. A small
Settings entry beside the theme toggle MUST open Appearance on the hub and
reading view. The existing composer Settings MUST also link to Appearance;
driver settings remain in the composer. Both theme controls
MUST remain reachable when chat is hidden, when no document exists or the
requested artifact is missing, during unsaved edits, and in read-only or
disconnected states. In the inverted Save/Discard and disconnected headers,
the toggle MUST use the header state's foreground and retain visible focus.

The button MUST have keyboard activation, visible focus, an accessible name,
and a pointer cursor. At 390px, controls MUST remain reachable without
overlapping the artifact title or Save/Discard actions. Placement follows
the application's top-right edge, including when chat visibility changes.

The application MUST resolve and apply the initial appearance before its
first styled paint in both `index.html` and `hub.html`, using the same parsing
rules as runtime changes. The
resolved appearance MUST set the root's `color-scheme` and select the
corresponding semantic token set. The existing `.dark` convention SHOULD
remain the selector for dark application tokens. Every application surface,
including portals, dialogs, selection states, disabled controls, errors,
comparison, and empty states, MUST have legible foreground/background pairs.
The implementation SHOULD retain the existing visual hierarchy and accent
roles. A whole-page inversion filter does not meet this requirement.
The reading view and hub SHOULD each retain their own token vocabulary with
both appearances defined. Shared `settings.css` fallbacks MUST resolve to the
same surface's vocabulary in light and dark; introducing hub tokens only in
the reading view's dark state would change its Settings color source.

### Artifact declaration and authoring contract

An artifact MAY declare its theme policy in its HTML head:

```html
<meta name="lucid-theme" content="adaptive">
```

The first matching `meta` element in the head supplies the policy. Trim ASCII
whitespace from its content, then accept only the exact lowercase values
below. Missing, empty, duplicate later, and unknown declarations MUST NOT
cause publication or rendering to fail. Later declarations are ignored;
an invalid first declaration means unmanaged. A declaration is per version,
so viewing an older version uses that version's policy.

| Policy | Appearance inside the frame |
|---|---|
| `adaptive` | Follow the application's resolved appearance |
| `light` | Retain authored light appearance |
| `dark` | Retain authored dark appearance |
| Unmanaged | Supply a system-derived frame preference in both locations; preserve authored styles without promising automatic adaptation |

The parser MUST inspect stored markup without executing scripts, fetching
resources, or mounting it into the application DOM. It MUST NOT guess theme
support from background colors, `.dark` classes, or a model's prose.
Reuse the inert parse5 approach used by `preferredArtifactWidth` in
`src/server/client/artifact-width.ts`. The first direct matching head element,
HTML attribute-name handling, ignored body metadata, and invalid-first result
follow the `lucid-width` precedent and its tests. Theme values retain the
explicit ASCII-whitespace and lowercase allowlist rules specified above.

Adaptive artifacts MUST declare browser support with
`<meta name="color-scheme" content="light dark">`, provide complete light
and dark palettes, and select the dark palette with
`@media (prefers-color-scheme: dark)`. Each palette MUST cover text,
backgrounds, links, borders, controls, focus, diagrams, and chart labels.
The artifact owns its semantic colors and typography; application token
names and palette values are not its design system.

#### Graphics and saved content

An adaptive artifact MUST change its appearance without changing its
serialized HTML or SVG solely because the theme changed. SVG and DOM-based
charts MUST select palette values through static CSS media rules and semantic
custom properties. Theme changes MUST NOT rewrite attributes such as `fill`,
inline styles, classes, text, or form values. Scripts MAY generate the chart
structure from content; its light/dark styling then follows the static rules.

Canvas and WebGL graphics MAY read the same media query and repaint when it
changes, provided the repaint changes only transient drawing state. It MUST
preserve serialized markup, user input, and interaction state. These graphics
retain the existing requirement for adjacent accessible explanation; the
theme feature does not introduce a different annotation model for them.

For example, an SVG circle can keep `fill="var(--chart-ink)"` in both
appearances while static media rules assign different values to `--chart-ink`.
A listener that rewrites the circle's `fill` attribute on every theme change
does not comply. Lucid's snapshot copies the live document, so it would save
that attribute. The reusable authoring example MUST include this distinction.

Artifact authors MUST NOT write parent-message handlers or read parent
storage for theme selection. CSS-only artifacts need no theme JavaScript.
This contract adds no snapshot hooks for restoring guessed original chart
values. A library that can adapt only by rewriting serialized markup needs
an authoring change before its output can claim adaptive support.

Fixed-theme artifacts MUST pair their declaration with the matching standard
color-scheme metadata and authored foreground/background pairs. For a fixed
light document, `only light` MAY be used in the standard metadata. Explicit
user or subject-design requirements determine when a fixed theme is needed.

The authoring guidance in `skills/lucid-design/SKILL.md` MUST make adaptive
the default for new reading artifacts and provide a reusable, verified
example. `skills/lucid/SKILL.md` MUST point authors to that contract from its
emission guidance. After delivery, `docs/artifacts.md` owns the runtime
contract; guidance links to it instead of duplicating protocol rules.
Standalone adaptive HTML follows the browser preference without Lucid.

### Native connection across the frame boundary

Lucid MUST use the same policy function in the reading frame and full-document
comparison inspection frame. It sets the embedding iframe's `color-scheme`:

| Policy | Embedding element value |
|---|---|
| `adaptive` | The application's resolved `light` or `dark` |
| `light` | `light` |
| `dark` | `dark` |
| Unmanaged | `light dark`, independent of the application's override |

The unmanaged rule preserves the current reading-frame preference. It
**changes comparison inspection**, which currently inherits the light-only
application's `light` scheme. With a dark system preference, an unmanaged
document using media queries can therefore become dark in inspection after
this change. Both frame locations will supply the same system-derived
preference for that version. This deliberate compatibility adjustment avoids
different appearances caused solely by opening the same document in inspection;
it does not recolor hardcoded styles or enroll the document in application sync.

The browser uses the embedding element's color scheme as the embedded
document's preferred scheme. That supplies the adaptive artifact's media
query without giving either document DOM access to the other. This is
specified by [preferred page schemes](https://drafts.csswg.org/css-color-adjust-1/#color-scheme-page),
with the `light dark` choice defined by
[scheme resolution](https://drafts.csswg.org/css-color-adjust-1/#color-scheme-resolution),
and documented for cross-origin iframes by
[MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme).

Changing appearance MUST update the embedding element in place. It MUST NOT
change the iframe key, replace `srcDoc`, reload the document, or add a theme
attribute to the authored document. The initial frame style MUST be present
when the frame is mounted. Native propagation does not require a theme
message, a ready/acknowledgment exchange, or retry timers. Existing annotation
messages retain their current contract and validation.

The declaration is an author claim, not proof of complete styling. If the
artifact ignores the media query or hardcodes conflicting colors, Lucid
MUST preserve the document and its reading controls. Visual verification,
not runtime CSS rewriting, establishes that an adaptive artifact complies.

### Annotation controls, edits, and comparisons

Lucid's injected annotation controls MUST provide both token sets using the
same frame media query. Their properties MUST remain namespaced so they
cannot replace authored theme tokens. Controls therefore follow the frame's
appearance, including a fixed dark artifact within a light application.
For unmanaged documents, the control palette follows the frame's system-derived
media query, even when the application's override differs. This is a preference
signal, not a determination of the authored background. Lucid retains the
existing authored-background fallback and MUST NOT claim it has determined the
document's visual theme. The mixed-background case is included in verification.

Switching MUST preserve scroll, focus, text selection, form values, pending
notes, document mode, unsaved edits, and comparison recovery. A theme-only
change applied by Lucid MUST NOT mark the artifact dirty or modify authored
markup. For a conforming adaptive artifact, normalized snapshots taken before
and after switching MUST be identical when content and input are otherwise
unchanged, including after script-rendered graphics have finished repainting.
Explicitly authored metadata and both palettes remain in saved/exported
documents; the reader's current override does not. Existing snapshot cleanup
continues to remove injected annotation styles and scripts.

This guarantee relies on the graphics authoring rules above. A declaration
alone does not enforce them. If a document's own script changes serialized
markup in response to a theme, the existing save semantics preserve those
authored mutations; Lucid MUST NOT guess which values to remove or silently
rewrite them. Such an adaptive document fails authoring verification. The
runtime still renders and saves it normally, without claiming conformance.

Comparison UI follows the application. Inspecting an authored version uses
that version's frame policy. Theme switches MUST NOT reparse comparison
content, change version ancestry, or invalidate annotation anchors.

## State Machine

Let `P` be the preference, `S` the browser-reported system appearance, and
`R` the resolved application appearance. Resolution is `R = S` when
`P = system`, otherwise `R = P`.

| Event | Next preference | Next appearance | Persistence |
|---|---|---|---|
| First visit or invalid stored value | `system` | Current S | No automatic write required |
| Activate toggle while R is light | `dark` | Dark | Store `dark` |
| Activate toggle while R is dark | `light` | Light | Store `light` |
| Choose Light or Dark in Settings | Chosen value | Chosen appearance | Store value |
| Choose Follow system | `system` | Current S | Store `system` |
| System changes while P is system | Unchanged | New S | No write |
| System changes during an override | Unchanged | Unchanged | No write |
| Another tab changes or clears storage | Parse current stored value | Resolve again | No write |
| A new artifact/version mounts | Unchanged | Unchanged | No write; apply its frame policy |

There are no pending or terminal theme states. Storage failure changes the
durability of a choice, not its immediate application. Frame policy is a
projection of the preference and declaration, not a second user preference.

## Error Handling

These identifiers name bounded internal outcomes, not new server errors.

| Outcome | Required recovery and visibility |
|---|---|
| `theme-storage-unavailable` | Guard storage access, reads, and writes. Keep the choice in memory for the current page. Settings reports “Appearance applies here but could not be saved.” No automatic retry loop; the next explicit choice can retry. |
| `theme-preference-invalid` | Resolve to System. Do not block rendering or show a modal. A later explicit choice replaces the invalid value. |
| `theme-system-unavailable` | If media-query observation is unavailable, System resolves to light; explicit choices still work. |
| `theme-declaration-invalid` | Treat the document as unmanaged. Preserve bytes and all existing interactions. No publication rejection. |
| `theme-authoring-incomplete` | A render check identifies missing or unreadable styling. Correct the authored artifact before claiming compliance; runtime does not recolor it. |

If storage failed, persistence across navigation, restarts, and other tabs
is not guaranteed. A malformed declaration alone MUST NOT produce warning
noise in the transcript. Browser support failures found during the native
propagation acceptance test block delivery of adaptive synchronization;
they do not justify silently relaxing the sandbox or adding a second theme
transport in implementation without revising this RFC.

## Security Considerations

The artifact remains untrusted content in `sandbox="allow-scripts"` without
`allow-same-origin`, as required by [ADR 0008](../adr/0008-browser-and-agent-content-have-separate-authority.md).
The parent reads only the bounded declaration from the stored markup and
sets a property on the iframe element it owns. No new artifact-origin
message can write a preference or invoke application actions.

Preference and declaration parsing MUST use the specified allowlists.
Neither value is interpolated into executable code, selectors, arbitrary
CSS, or resource URLs. The preference contains no tokens, paths, record
content, or credentials. The artifact can observe its selected appearance,
which is necessary for rendering, but receives no access to browser storage
or the distinction between System and an explicit override.

The largest expected failure is an unreadable appearance in one surface.
Theme failure MUST NOT affect record writes or artifact authority. The
implementation MUST respect browser accessibility overrides, including
forced colors, and MUST NOT disable them to enforce a palette.

## Alternatives Considered

| Alternative | Reason considered | Reason not selected |
|---|---|---|
| Application-only dark mode | Gives the reader manual control immediately | Does not deliver the agreed synchronization for compatible artifacts |
| New theme messages plus an injected document attribute | Fits the existing message channel and supports custom events | Native frame color-scheme propagation provides this signal without load races, runtime document mutations, or snapshot cleanup rules |
| Force every artifact to follow the application | Removes the capability declaration | Cannot establish that arbitrary HTML supports both palettes and violates fixed-theme exceptions |
| Infer the application's theme from artifact colors | Could visually match an arbitrary document | Mixed palettes and changing content make inference ambiguous; it also makes documents control the reader's application preference |
| Let the model implement the communication code | Could bundle everything into generated HTML | Repeats runtime wiring per document and makes switching reliability depend on generated handlers |
| Store the preference in each record or on the server | Could share it across browsers or origins | Gives a reading preference record or server scope the user did not request |

The explicit `lucid-theme` marker is separate from standard `color-scheme`
metadata: the former opts into Lucid's documented behavior, while the latter
declares browser rendering support. Existing standard metadata alone does
not promise that a document follows this authoring contract.

## Implementation Plan

Implementation starts only after the repository's separate RFC review and
ticket workflow. The implementing developer or agent owns all phases.

1. Prove native propagation with a minimal adaptive fixture and fixed light,
   fixed dark, and unmanaged controls in the existing iframe sandbox. Check
   initial rendering and live switches in the browser used for Lucid's
   browser evidence. A failure blocks the remaining integration; resolve the
   browser behavior or revise the proposed connection first.
2. Add the shared browser preference module, initial-paint bootstrap, toggle,
   and Appearance settings. Give the complete application and injected
   annotation styles light/dark tokens. Verify the application independently
   of agent availability and artifact readiness. Keep platform sources
   injectable and check Settings fallbacks in both application shells.
3. Add declaration parsing and apply policy to every instrumented document
   frame. Use the same policy function in reading and comparison inspection.
   Verify that switching preserves edits and frame identity before enabling
   adaptive authoring guidance.
4. Publish the verified authoring example in the repository guidance and
   update `docs/artifacts.md`, the comparison-theme and Limits of the design
   sections in `docs/design.md`, and the light-only/token-coupling comments in
   `app.css` and `instrument.ts`. Update the behaviour reference as described
   below. On implementation, follow the RFC index's lifecycle.

The standalone behaviour reference consumes the exported instrumentation
stylesheet in its parent document. Its annotation examples MUST instead use
isolated light and dark preview frames, setting the embedding scheme explicitly
and using the same instrumentation stylesheet. Application examples can then
use their explicit appearance tokens without an unrelated OS preference
changing the annotation samples. Keep `reference.html` a deterministic preview
of both appearances, without reading or writing the reader's theme preference.
Preserve its self-contained output and verify it with `bun run build:reference`.

Delivery MUST pass `bun run check` and `bun run build`. Deterministic tests
MUST cover preference resolution, invalid/blocked storage, same-origin tab
updates, declaration parsing, fixed/unknown policies, and snapshot invariance.
Metadata tests SHOULD follow `test/server/artifact-width.test.ts`, including
comments, script strings, case handling, body metadata, and invalid-first input.
Browser evidence MUST cover:

- System light/dark, both manual overrides against the opposite system
  setting, Follow system, reload, browser restart, and two open tabs.
- First paint, adaptive/fixed/unmanaged documents, both frame locations,
  and live appearance changes without iframe reload.
- A dark system with an explicit Light application override: compare the old
  inherited-light inspection baseline with the new unmanaged `light dark`
  policy, and verify both frame locations now supply the same preference.
  Include an unmanaged document with hardcoded light backgrounds to check
  annotation contrast under a different frame preference.
- A dirty document with input values, selected text, scroll position, and
  a pending annotation; switching preserves each and creates no version.
- Hub, reading, chat, comparison, Settings, hidden chat, empty workspace,
  missing-artifact state, disconnected/read-only states, and Save/Discard
  controls at 390, 768, and 1440px in both appearances. Check the theme toggle
  within the normal, ink-filled Save/Discard, and magenta disconnected headers.
- A new generated artifact that follows the documented example, plus
  diagram/chart labels, keyboard focus, and selection contrast in both
  appearances. A model's declaration alone is not visual evidence.
- Static CSS-driven SVG and a canvas repaint: capture normalized snapshots
  in light and dark, waiting for repaint, and assert equality. Confirm that
  saving a human text edit then reopening under the opposite theme retains
  the edit and derives the correct palette. Keep a script-written SVG `fill`
  case as a negative authoring control: its differing snapshots demonstrate
  nonconformance, not a reason to change Lucid's serializer.

Browser evidence MUST name the browser/version actually tested. No live
harness claim is part of this change: the switching oracle uses fixed HTML
and no model process. Generated-document evidence checks authoring quality
separately from deterministic transport behavior.

No record migration, dual writes, or version rewrites are required. Existing
documents remain unmanaged until an author intentionally revises them. A
previous dual-palette document without `lucid-theme` will follow the system,
so the application's toggle will not make it follow an override. Inspection
also receives the compatibility adjustment specified above. If
the implementation is rolled back, the unused local storage key and inert
artifact metadata can remain; authored adaptive palettes still work as
standalone HTML. Roll back the feature if switching loses input, changes
saved content for conforming artifacts, or produces unreadable application controls.

## Review response

This revision answers the
[unversioned review](21_shared-application-and-artifact-themes.review-unversioned.md)
of SHA-256 `8542e6499a1f3171343ec91604eced4ac70a5826a2710be0bb680d4f945ba76e`.
The review remains evidence about that draft, not a review of revision 1.

| Review point | Revision 1 response |
|---|---|
| F1: graphic serialization | Added static DOM/SVG palette rules and transient-only canvas/WebGL repaint rules; scoped snapshot guarantees to compliant authoring and retained normal saves for nonconforming documents. Added positive and negative snapshot controls. |
| F2: unmanaged inspection | Specified `light dark` in both locations as a deliberate compatibility adjustment; documented the old inherited-light inspection baseline and added its before/after case. |
| F3: specification anchor | Linked the page-scheme propagation clause and the scheme-resolution algorithm directly. |
| Note 1: Settings tokens | Kept each surface's vocabulary and required consistent fallback resolution across appearances. |
| Note 2: metadata parser | Named the existing inert parse5 parser and its behavioral/test precedent for reuse. |
| Note 3: header states | Named missing-artifact and inverted-header states and required toggle legibility within them. |
| Note 4: current contracts | Named the design sections and source comments to update during implementation. |
| Note 5: test seams | Specified injectable storage/media-query sources using existing storage-module precedents. |
| Note 6: behaviour reference | Defined isolated light/dark annotation previews and a self-contained reference build check. |
| Withdrawn unmanaged-control finding | Made the already-selected frame-query behavior explicit and added the mixed-background test case; no new preference or inference behavior was added. |

No application code or current authoring guidance is changed by this revision.
Structural validation and bounded browser probes are author verification, not
a substitute for a fresh cross-family review of this revision.

## Open Questions

None. On 2026-09-09, Kevin confirmed the recommended Settings placement:
a small entry beside the top-right theme toggle on the hub and reading view,
with the composer Settings also linking to Appearance. Driver settings remain
in the composer. This resolves the former placement question while preserving
the agreed one-click behavior of the sun/moon button.

The native CSS connection, explicit artifact declaration, and origin-scoped
storage are proposed technical decisions for review. They do not reopen the
confirmed product behavior.

## References

### Normative

- [CONTEXT](../../CONTEXT.md) - product purpose and vocabulary.
- [Artifact contract](../artifacts.md) - sandbox, saves, and comparison boundaries.
- [ADR 0007](../adr/0007-document-edits-preserve-evidence.md) - immutable saved versions.
- [ADR 0008](../adr/0008-browser-and-agent-content-have-separate-authority.md) - browser/artifact authority separation.
- [ADR 0009](../adr/0009-a-preference-is-not-an-event-or-a-claim-about-reality.md) - preference ownership distinct from events.
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) - normative keyword meanings.
- [Preferred page schemes](https://drafts.csswg.org/css-color-adjust-1/#color-scheme-page) - propagation from the embedding element into the document.
- [Scheme resolution](https://drafts.csswg.org/css-color-adjust-1/#color-scheme-resolution) - selection from supported schemes such as `light dark`.

### Informative

- [Reading-view design](../design.md) - existing hierarchy and visual roles.
- [Lucid artifact design guidance](../../skills/lucid-design/SKILL.md) - current authoring expectations.
- [Artifact instrumentation](../../src/server/client/instrument.ts) - injected controls and snapshot cleanup.
- [Comparison inspection](../../src/server/client/content-comparison.tsx) - second full-document frame consumer.
- [MDN: prefers-color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme) - embedded and standalone appearance selection.
- [MDN: localStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage) - persistence boundaries and exceptions.
- [MDN: storage event](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event) - updates across same-origin tabs.

Browser references were checked on 2026-09-08. A revision-1
[sandboxed fixture probe](../../artifacts/evidence/rfc21-revision-01/probe.mjs)
using Lucid's actual instrumentation passed in Chrome 152.0.7977.77:
CSS-driven SVG and a canvas repaint changed appearance with identical
snapshots and retained frame identity and input; the script-written SVG
negative control changed the snapshot. It also confirmed the old/new
unmanaged inspection behavior. Its
[results](../../artifacts/evidence/rfc21-revision-01/browser-probe.json)
are local, ignored evidence. This bounded probe does not verify the full
application, first paint, contrast, or save/reopen behavior. Delivery still
requires the complete implementation checks specified above.
