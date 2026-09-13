# 10: Connect and verify the actual Codex desktop client

Status: open
Blocked by: 01, 02, 07, 08, 09

## What to build

The actual desktop authoring client participates in the same connection and handoff flow with client-specific evidence.

## Acceptance criteria

- [ ] Setup and trust are verified in the actual desktop interface, separately from CLI.
- [ ] Binding proves the particular interactive client and conversation; a shared server PID cannot establish client presence.
- [ ] Native receipt, response, interruption, absence detection and same-ID return are demonstrated in the desktop lane.
- [ ] If no supported client ownership or launch operation exists, preserve a specific unavailable result and leave this ticket incomplete for a user scope decision.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.
