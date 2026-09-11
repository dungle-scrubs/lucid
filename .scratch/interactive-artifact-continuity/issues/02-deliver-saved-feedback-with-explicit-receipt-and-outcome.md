# 02: Deliver saved feedback with explicit receipt and outcome

Status: open
Blocked by: 01

## What to build

A registered listener offers one eligible saved input and records receipt and response separately.

## Acceptance criteria

- [ ] Ordinary and managed browser inputs use FIFO eligibility and complete current context with original annotation evidence.
- [ ] Preparation is rechecked at dispatch; oversized or unsupported full context stays held intact.
- [ ] Receipt and response require the same verified offer and native participation; repeats are idempotent and stale or conflicting acknowledgements fail.
- [ ] Cancellation wins only before dispatch. Source loss without settled receipt and outcome blocks automatic replay and later offers.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.
