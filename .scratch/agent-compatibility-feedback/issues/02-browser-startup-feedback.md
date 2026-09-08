# 02 - Show startup compatibility feedback in the browser

Status: resolved
Blocked by: 01
Publication: local only
Source: RFC 20, version 2 - Check boundaries and lifetime; Diagnostic contract; Presentation and repair text; State Machine.

## What to build

Show retained HCN startup warnings and errors when the person enters the hub or
opens an artifact directly. Keep the record available even when HCN is missing,
slow, or unusable. Show the selected installation and its repair details below
the header or toolbar so closing chat cannot hide the notice.

Reuse ticket 01's facts and explanations. This slice supplies the browser's
single compatibility notice region and announcement owner for later selection
and execution feedback.

## Acceptance criteria

- [x] The browser runtime starts one shared HCN observation asynchronously or off its serving thread. The version probe settles within five seconds, limits each output stream to 4 KiB, and cleans up a timed-out child. The listener and healthy or damaged record reads remain available while it is pending or fails.
- [x] Hub entry and direct artifact entry request defaults without requiring the creation dialog. Defaults awaits the shared bounded startup result asynchronously; record reads do not await it. Both responses carry the RFC's additive compatibility list while preserving existing fields and status behavior.
- [x] Runtime diagnostics remain available without a valid driver selection. An empty or pending result makes no global compatibility claim. Opening multiple tabs or polling shares the observation and does not start repeated diagnostic processes.
- [x] A persistent notice region below the hub header or conversation toolbar remains visible and accessible with chat closed. Notices explain the affected operation and startup observation, provide known versions, and expose safe installation provenance and observation time in keyboard-accessible details.
- [x] Text distinguishes warnings from errors. One shell-owned polite live region announces each applicable diagnostic once per document lifetime using the RFC's fact-based deduplication. Existing error surfaces do not repeat its announcement, move focus, or reopen chat.
- [x] The notice retains its original observation time and uses past-observation wording until runtime restart. File changes or a browser reload do not imply a fresh startup inspection. Restart repeats initialization without submitting or altering input.
- [x] Runtime initialization errors use the safe-message contract in the compatibility list and existing settings/API error fields. Existing error codes and document operations remain unchanged; failed HCN initialization does not invent a harness mismatch.
- [x] The existing same-origin/token boundary protects diagnostics. Artifacts gain no installation authority. The feature introduces no pending-status control, updater, Check again control, periodic process probe, automatic repair, or artifact-creation check.
- [x] Fake-HCN browser scenarios demonstrate unavailable, slow, malformed, old, matching, and drifting HCN on hub and direct entry, including healthy/damaged records, multiple tabs, a closed chat panel, keyboard use, announcement deduplication, and widths of 390, 768, and 1440 pixels.
- [x] Package and compiled browser runs demonstrate release-pin provenance and record access with failed startup inspection. Current API/browser contracts and deterministic tests cover this slice; repository check, build, and whitespace gates pass.

## Resolution

Implemented autonomously on `feat/agent-compatibility-feedback` in
`/Users/kevin/dev/lucid-compatibility`. unavailable-hcn.test.ts proves shared nonblocking startup, healthy/damaged reads and rejected-observation fallback. compatibility-notice.test.tsx proves focus and announcement deduplication. browser-matrix.log covers six HCN states on hub/direct entry; record reads take 1-2 ms. Compiled and package browser test entries use an isolated port and synthetic HCN; source and compiled views were checked at 390, 768 and 1440 px. Keyboard Enter opens native installation details.

Final gates: `bun run check` passed 1,385 tests / 7,124 assertions;
`bun run build`, `bun run build:package`, and `git diff --check` passed.
One independent four-axis review ran through opus-5@claude. Its corrections
were applied; full reports and browser/process evidence are ignored under
`artifacts/evidence/compatibility/`. No model call was used for feature
verification. No publication or landing is included.
