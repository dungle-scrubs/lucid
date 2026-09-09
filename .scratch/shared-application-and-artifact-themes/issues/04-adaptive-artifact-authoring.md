# 04 - Author and verify adaptive reading artifacts

Status: draft
Blocked by: 03
Publication: local only
Source: RFC 21, revision 1 - Artifact declaration and authoring contract; Graphics and saved content; Implementation Plan; review finding F1.

## What to build

An author following Lucid's guidance produces an adaptive reading artifact by
default, using a reusable example that works both inside Lucid and standalone.
The reader can switch, annotate, edit, save, and reopen that document in either
appearance. Explicit user or subject-design requirements can still select a
fixed theme.

## Acceptance criteria

- [ ] Design guidance defaults new reading artifacts to the adaptive declaration, matching standard browser metadata, complete semantic light/dark palettes, and the native media-query contract. Emission guidance directs authors to it; the current artifact contract owns runtime rules rather than duplicating them across skills.
- [ ] The reusable example covers prose, links, controls, explicit keyboard focus, a diagram or chart with readable labels, and an adjacent accessible explanation for canvas graphics. Artifact colors and typography remain authored rather than copying application token names or branding.
- [ ] Guidance and example distinguish static CSS-driven DOM/SVG colors from transient canvas/WebGL repaint. Theme changes preserve serialized attributes, classes, inline styles, text, form values, and interaction state. Scripted chart construction from content remains supported; a library that changes serialized styling on theme switches cannot claim compliance without an authoring change.
- [ ] Fixed-light and fixed-dark guidance pairs the Lucid declaration with matching browser support and authored foreground/background pairs. Existing versions remain unmanaged unless intentionally revised; standalone adaptive HTML follows the browser preference.
- [ ] Generate a new artifact from the delivered guidance and inspect its rendered output in both application appearances and standalone system appearances. Verify text, chart labels, focus, selection, controls, and responsive reading at 390, 768, and 1440px. Record the browser/version and distinguish authoring evidence from transport proof.
- [ ] In that generated artifact, operate controls, add a pending annotation, edit text, switch appearance, save, and reopen under the opposite appearance. Input and notes survive switching; saved content retains the human edit and derives the correct palette without storing the reader's override. Run positive snapshot checks after graphic repaint and retain the nonconforming SVG example as a negative control.
- [ ] Current authoring and runtime documentation agree on adaptive, fixed, and unmanaged behavior, including the inspection compatibility adjustment and browser-origin storage boundary. Repository check, build, reference-build, and whitespace gates pass. All earlier ticket evidence is present before claiming RFC delivery complete.
