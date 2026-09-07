# Retry a browser send without duplicating its input

Status: draft
Blocked by: none

## What to build

A browser send with a lost response can be retried or reconciled without adding another input to the conversation. This supplies the submission behavior needed by inline comparison notes while preserving existing source-protocol duplicate rules.

## Acceptance criteria

- [ ] The client retains one identity and immutable payload across an uncertain send outcome.
- [ ] A repeated accepted request returns its original receipt, including after another artifact version arrives, after the input is applied, and after the server restarts.
- [ ] Reusing an accepted identity with a different payload returns an explicit conflict. It neither changes the original input nor creates another.
- [ ] An already accepted identity is resolved before fresh-request capacity or version preconditions. Rejected attempts are not mistaken for accepted receipts merely because a log entry exists.
- [ ] Concurrent identical submissions produce exactly one accepted input and one transcript entry.
- [ ] Older clients that omit the identity still work. Source-protocol duplicate admission retains its existing meaning.
- [ ] Authentication, payload bounds, record scoping, and readable failure states remain intact.
- [ ] Deterministic browser-to-record tests cover lost responses, concurrent retries, payload conflicts, restart/replay, and queue pressure. All repository checks pass.

## Parent

[RFC 14: Annotated content comparison](../spec.md)
