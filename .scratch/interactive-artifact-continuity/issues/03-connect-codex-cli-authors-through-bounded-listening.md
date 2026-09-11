# 03: Connect Codex CLI authors through bounded listening

Status: open
Blocked by: 01, 02

## What to build

Installed Codex CLI integration registers the current session, connects publication, and handles browser feedback in that native session.

## Acceptance criteria

- [ ] Isolated native setup preserves other hooks and excludes subagents and managed headless children.
- [ ] A 45-second synchronous wait performs no model calls while waiting; interruption or expiry disables listening until explicit resume-listen.
- [ ] Native receipt and response commands preserve identity and full feedback context; output preview or spill cannot masquerade as full delivery.
- [ ] Real native acceptance covers publication, feedback, cancellation, interruption and same-session identity.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.
