# Discover and group real conversations

Status: implemented locally on feat/hub-discovery; not pushed
Blocked by: none
GitHub: [Discover and group real conversations](https://github.com/dungle-scrubs/lucid-v2/issues/205)

## What to build

Open the hub and find the same local conversations that the terminal creates. Group each under its nearest repository root or starting folder, while retaining the exact working folder and existing artifact interactions.

## Acceptance criteria

- [x] CLI and hub use one effective record root and one metadata-identity resolver. Renamed directories remain addressable; missing or duplicate identities never select or create another record.
- [x] Cold discovery rebuilds without a registration database. Staging directories stay excluded, malformed records have individual errors, and inaccessible roots are not reported as empty history.
- [x] Filesystem hints plus bounded reconciliation reveal new records within five seconds while the server runs. Pagination does not duplicate identities or compromise creation-ID reconciliation.
- [x] Nested repositories, worktrees, ordinary folders, matching basenames, symlinks, and subfolder working directories follow the project rules. Legacy records appear under No project without writes or model calls.
- [x] Existing record endpoints refuse unknown identities; explicit terminal creation publishes identity and known folder association atomically.
- [x] Browser verification covers opening a listed conversation and intact reading, editing, annotations, and version navigation at 390, 768, and 1440 pixels. Repository checks pass.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.

## Verification

`bun run check`: 1,051 tests pass, plus lint and both typechecks. `bun run build` passes. Browser checks at 390, 768, and 1440 cover search, group collapse, opening a record, version navigation, saved edits, and submitted annotations. Focus reconciliation and stop-and-Reload after a rejected token also pass. Four review axes ran through Opus on Claude; the findings were applied or explicitly dispositioned before commit. Run evidence is under ignored `artifacts/evidence/` in the implementation worktree.

User config, creation defaults, generated titles, managed startup, native resume, context transfer, and recovery remain in tickets 02 through 08.
