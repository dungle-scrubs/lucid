# 03 - Synchronize artifacts and annotation controls without losing edits

Status: complete
Blocked by: 02
Publication: local only
Source: RFC 21, revision 1 - Artifact declaration and authoring contract; Native connection across the frame boundary; Annotation controls, edits, and comparisons; Security Considerations; review findings F1 and F2.

## What to build

Changing application appearance changes a compatible document in place,
including when inspecting a historical version. Fixed-theme documents retain
their declared appearance. Unmanaged documents receive system preference in
both frame locations. Lucid's annotation controls follow that frame preference
while the reader keeps edits, input, notes, and position.

## Acceptance criteria

- [x] Stored markup supplies one version-specific policy through the existing inert metadata-parsing approach. The first direct matching head declaration wins; ASCII whitespace is trimmed and only exact lowercase allowed values are accepted. Missing, invalid, empty, and invalid-first declarations are unmanaged, with later duplicates ignored. Tests cover comments, script strings, attribute-name casing, body metadata, and non-ASCII whitespace.
- [x] Both reading and full-document comparison inspection use the same policy function: adaptive follows the resolved application appearance, fixed light/dark uses its declared value, and unmanaged uses system preference independently of the application override. Standard browser metadata alone does not opt a document into adaptive support.
- [x] The embedding scheme is present on initial mount and updated in place. Frame key, document source, window/document identity, sandbox, and existing validated annotation-message contract remain unchanged. Parsing does not mount content, execute scripts, or fetch resources; artifacts gain no parent storage or DOM access.
- [x] Browser evidence covers initial and live switches for all four policies in both frame locations, including older versions with different declarations. Under a dark system and Light application override, record the old inherited-light inspection baseline and verify the new unmanaged inspection and reading preferences agree.
- [x] Injected annotation controls use namespaced light/dark palettes selected by the frame query. Verify fixed-dark documents within a light application and unmanaged hardcoded light backgrounds under a dark system, preserving readable controls and the existing authored-background fallback without inferring the document's theme.
- [x] A dirty document retains scroll, focus, selection, form values, pending notes, document mode, unsaved edits, and comparison recovery through switches. Switching neither marks it dirty nor creates a version, reparses comparison content, changes ancestry, or invalidates anchors.
- [x] Positive CSS-driven SVG and transient canvas repaint fixtures change visible appearance while one-way light-to-dark and dark-to-light normalized snapshots stay equal after repaint. A script-written SVG attribute fixture changes the snapshot as a negative authoring control; normal save semantics preserve that mutation without guessed cleanup.
- [x] Saving a human text edit and reopening under the opposite appearance preserves the edit, metadata, both authored palettes, and ancestry. The saved artifact excludes injected annotation code and the reader's override. Invalid or nonconforming declarations do not block normal rendering or saves or produce transcript warnings.
- [x] Annotation examples in the self-contained behaviour reference run in isolated explicit light/dark frames using the real injected stylesheet. Their appearance is deterministic under either OS preference and they never touch the reader's preference.
- [x] Deterministic parser, policy, preservation, and snapshot tests pass alongside the integrated browser cases. Runtime artifact contracts, comparison compatibility notes, and obsolete token-coupling comments match the change. Repository check, build, reference-build, and whitespace gates pass.

Implementation: `feat/shared-application-and-artifact-themes`, isolated from the main checkout. Verification and review decisions: `artifacts/evidence/shared-themes/completion.md` (local run output).
