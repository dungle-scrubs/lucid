# 01 - Choose and retain the hub appearance

Status: complete
Blocked by: none
Publication: local only
Source: RFC 21, revision 1 - Preference ownership and storage; Controls and application appearance; State Machine; Error Handling; native propagation prerequisite.

## What to build

The hub follows the system appearance on first use. Its upper-right moon or
sun button immediately selects the opposite appearance. A small Settings
entry beside it opens Appearance with Light, Dark, and Follow system. The
choice survives normal browser restarts and stays consistent across hub tabs.

Establish one shared browser preference owner through this working surface,
including initial rendering, persistence, subscriptions, and failure handling.
Before integration, extend or reuse the bounded native-frame probe to cover
every declared policy under the existing sandbox. A failed probe blocks
integration as the RFC requires.

## Acceptance criteria

- [x] The native prerequisite verifies initial and live adaptive light/dark propagation, fixed light/dark, and unmanaged system preference in the existing sandbox. Evidence names the browser/version; no sandbox relaxation or second theme transport is introduced.
- [x] Missing or invalid stored preference selects System. System changes apply immediately only while following System; an override remains fixed. Missing system observation falls back to light while manual controls still work.
- [x] The moon selects Dark from a light appearance; the sun selects Light from a dark appearance. Clicking while following System creates an override. Appearance identifies the selected preference and Follow system immediately resumes the current system appearance.
- [x] One shared owner uses the RFC storage key and literal allowlist. Storage and media-query sources are injectable. Reads, writes, and even access to storage are guarded; a failure retains the current-page choice and shows the RFC's persistence explanation without blocking the hub or retrying in a loop.
- [x] The writing tab updates immediately; other same-origin tabs read the latest stored value on relevant storage events, including removal and clear, without echo writes. Page restoration refreshes storage and system state. Reload and browser restart retain a successfully saved override.
- [x] The hub resolves appearance before first styled paint using the runtime parsing rules. Both palettes cover normal, empty, search, creation, dialog, error, disabled, selection, and focus states. Settings uses the hub's vocabulary consistently in both appearances.
- [x] Controls have the RFC's accessible names, keyboard activation, visible focus, and pointer cursors. At 390, 768, and 1440px they remain reachable without overlap. Browser accessibility overrides remain effective.
- [x] Preference changes work without an agent or network response and do not write records, driver preferences, recovery drafts, server settings, or artifact bytes.
- [x] Deterministic tests cover the full preference state machine and platform failures. Browser checks cover both system values, opposite overrides, Follow system, first paint, reload, restart, two tabs, and hub interactions at all three widths.
- [x] Current hub appearance documentation and explicit light/dark behaviour-reference examples match the delivered surface. Repository check, build, reference-build, and whitespace gates pass. The reference remains self-contained and does not read or write the reader's preference.

Implementation: `feat/shared-application-and-artifact-themes`, isolated from the main checkout. Verification and review decisions: `artifacts/evidence/shared-themes/completion.md` (local run output).
