# 06: Connect Claude CLI authors through lifecycle hooks

Status: open
Blocked by: 01, 02

## What to build

Claude lifecycle and safe turn-boundary hooks connect the current authoring session to browser feedback.

## Acceptance criteria

- [ ] Isolated supported hooks capture exact identity and reject stale, subagent and managed-child callbacks.
- [ ] Browser feedback enters at the safe boundary without steering unrelated native work.
- [ ] Receipt and response are verified separately from hook transport success.
- [ ] Native process acceptance uses an isolated local response stub or approved local route, with no Anthropic model inference.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.
