# Discover and group real conversations

Status: open
Blocked by: none
GitHub: [Discover and group real conversations](https://github.com/dungle-scrubs/lucid-v2/issues/205)

## What to build

Open the hub and find the same local conversations that the terminal creates. Group each under its nearest repository root or starting folder, while retaining the exact working folder and existing artifact interactions.

## Acceptance criteria

- [ ] CLI and hub use one effective record root and one metadata-identity resolver. Renamed directories remain addressable; missing or duplicate identities never select or create another record.
- [ ] Cold discovery rebuilds without a registration database. Staging directories stay excluded, malformed records have individual errors, and inaccessible roots are not reported as empty history.
- [ ] Filesystem hints plus bounded reconciliation reveal new records within five seconds while the server runs. Pagination does not duplicate identities or compromise creation-ID reconciliation.
- [ ] Nested repositories, worktrees, ordinary folders, matching basenames, symlinks, and subfolder working directories follow the project rules. Legacy records appear under No project without writes or model calls.
- [ ] Existing record endpoints refuse unknown identities; explicit terminal creation publishes identity and known folder association atomically.
- [ ] Browser verification covers opening a listed conversation and intact reading, editing, annotations, and version navigation at 390, 768, and 1440 pixels. Repository checks pass.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.
