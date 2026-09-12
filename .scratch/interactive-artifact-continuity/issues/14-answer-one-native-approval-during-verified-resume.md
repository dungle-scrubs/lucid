# 14: Answer one native approval during verified resume

Status: open
Blocked by: 13

## What to build

A caller runs one exact resumed response through HCN and answers its native permission request over the same live process channel.

## Acceptance criteria

- [ ] The opt-in public command refuses unsupported combinations before spawn and verifies effective settings before any prompt.
- [ ] Command, file and permission choices preserve exact offered scope; unsupported variants fail with owned cleanup.
- [ ] Duplicate decisions, clear/write races, concurrent requests, channel loss and deadlines retain at-most-one native response write.
- [ ] Node and Bun public and injected-process tests pass; ordinary run/session behavior remains covered.

## Parent

RFC 27 v2, extending RFC 26 and ticket 08. Machine-made slicing under Kevin's autonomous implementation instruction. Local tracker only.
