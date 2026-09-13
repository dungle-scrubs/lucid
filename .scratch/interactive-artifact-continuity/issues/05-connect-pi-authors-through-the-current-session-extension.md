# 05: Connect Pi authors through the current session extension

Status: open
Blocked by: 01, 02

## What to build

Pi uses its existing native session extension to register, listen and respond to browser feedback.

## Acceptance criteria

- [ ] The extension captures the current session identity, cwd and native process without opening an alternate RPC session.
- [ ] Cancellation and the declared wait bound revoke readiness while retaining accepted feedback.
- [ ] Native receipt and response correlate each offer; full context is preserved.
- [ ] Native acceptance covers custom session storage and proves the actual session can be strictly resumed.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Native prerequisites and blocker - 2026-09-13

Native Pi 0.85.1 with isolated storage passed a 45-second agent_end wait and Escape cancellation. An existing full UUID in a custom session directory loaded prior context; an initially missing UUID refused. A TUI parent and its direct JSON child loaded the same ID but reported distinct callback modes. These probes do not establish production binding, receipts, SDK/root provenance, or HCN launch support.

A fault-injected native run then deleted the selected synthetic session file between ID lookup and open. Pi reached session_start with a new native ID at the old path. Thus --session FULL_UUID plus --session-dir is not strict across that race. HCN preflight cannot make it satisfy the accepted no-new-session contract. Native strict open is required before this lane can enable.

RFC 28 v2 preserves the candidate bridge design, the Muse v1 findings and their unresolved disposition. It is Draft, not implementation authority. Evidence: ignored artifacts/evidence/interactive-artifact-wayfinder/pi-native-prerequisites.md and pi-negative-acceptance.md in the main checkout. All owned probes and pane w2M:p1M are closed. Codex completion takes priority; this ticket remains open and Pi remains unavailable.
