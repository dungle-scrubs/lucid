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
