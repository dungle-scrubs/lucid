# Retry a browser send without duplicating its input

Status: resolved
Blocked by: none

## What to build

A browser send recovers from a lost response, server restart, and required page reload without creating another input or losing the original request. Deliver the recovery interaction through the existing browser input boundary and durable record, verifiable independently before comparison controls are enabled.

This covers RFC 14 revision 4's repeat-safe submission contract. Historical-source validation and comparison entry belong to ticket 03. General unsent-draft persistence and synchronization across tabs remain outside scope.

## Acceptance criteria

- [x] The browser endpoint accepts an optional client-generated identity with existing input text and fixes mode to queue. Clients omitting the identity and source-protocol duplicate rules retain their behavior.
- [x] Before the first network attempt, create one identity and exact serialized payload; write and read back one versioned unresolved-request entry per conversation in this tab, with conversation, artifact, identity, and exact body. Failed storage or unequal readback produces local E-COMP-08, preserves the draft, and sends nothing.
- [x] While unresolved, disable another comparison submission for that conversation. Transport failure, unreadable response, wrong receipt identity, and authorization failure retain the request; its note, reviewed base, and identity cannot change or be cancelled as though unsent.
- [x] A restart followed by 401 retains Reload. Same-origin reload validates recovered data and offers explicit Retry in the open conversation. Reload alone never sends, silently renews a token, or submits another conversation's request.
- [x] Retry reconciles the unchanged identity and body. Failed retries stay visible without a timer loop or replacement identity.
- [x] Serialized acceptance resolves identical accepted requests before fresh-request capacity or version checks, returning their original receipt after application, a newer artifact version, or restart. Receipt lookup uses accepted history, not merely attempted inputs in the log.
- [x] Concurrent identical requests produce one accepted input. Conflicting text under an accepted identity returns E-COMP-06 without changing the original. Comparison receipts support durable input identity and note index zero for ticket 03.
- [x] A known acceptance clears recovery state. An explicit admission refusal restores editable note text and source evidence before clearing it; stale drafts require review before a fresh send. Authentication failure is not an admission refusal.
- [x] Cleanup failure keeps the known outcome visible and blocks a new comparison send until cleanup succeeds. Retained accepted requests remain safe to retry.
- [x] Malformed recovery entries are not submitted or silently replaced. E-COMP-08 preserves readable note text for inspection; explicit discard explains that it does not cancel an accepted input and sends no replacement.
- [x] Recovery data is bounded, conversation-scoped, validated, and rendered inertly. It contains no tokens, secrets, complete documents, or attachment blob store. Tab close, cleared storage, and changed origin gain no recovery guarantee.
- [x] Deterministic browser-to-record verification covers accepted response loss followed by restart, 401, reload, and Retry; a request never accepted; concurrent and copied-tab retries; changed payload; applied input; capacity pressure; storage failure; malformed data; and cleanup failure. Exercise the browser recovery interaction independently before comparison entry is enabled.
- [x] Update the current browser input and reload-recovery contracts. All repository checks pass without waived gates. Comparison controls remain disabled until their complete delivery path exists.

## Parent

[RFC 14, revision 4: Annotated content comparison](../spec.md)

## Comments

Delivered the repeat-safe browser endpoint, accepted-history receipt lookup under the append lock, per-tab recovery controller, and recovery controls. The controls are exercised independently against the real endpoint; ticket 03 connects them to comparison entry. Existing ordinary send controls remain unchanged.

Verification: 25 focused server, browser-storage, and control-interaction tests pass, including acceptance followed by lost response, restart, 401, reload, and explicit Retry. The full repository check passes with 1,060 tests and 5,244 assertions; the compiled binary build passes. Current browser input and recovery contracts are updated. No shared issue was published.
