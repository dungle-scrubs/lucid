# Send a historical note and revise current content

Status: draft
Blocked by: 01, 02

## What to build

A person selects earlier or current content, writes a note beneath that passage, and sends it once. The note appears in the normal conversation transcript with its historical source. The agent receives the current document and produces an ordinary new version rather than rolling the artifact back.

## Acceptance criteria

- [ ] Selecting text or a whole passage opens one compact note box on the selected side. No conversation transcript or second chat composer appears within the diff.
- [ ] Sending retains the draft until durable acceptance; then it closes the box and shows one transcript entry plus a source marker. Queued, failed, and uncertain outcomes use the real input lifecycle.
- [ ] Batch version retains the source version for legacy projections. Reviewed version/hash and dispatch target are distinct; the dispatch target alone controls emission. A comparison input contains one note from one source version and never automatically flushes or mixes an ordinary queue.
- [ ] Notes on removed content retain their quote, source version, author, source hash, and source address. New comparison metadata is validated; malformed metadata is not downgraded into a legacy note.
- [ ] Saved-source notes cannot silently coexist with unsaved edited content. The comparison pair stays fixed on new-version arrival even without a draft, until explicitly refreshed.
- [ ] Source evidence survives version changes, comparison closure, reload, and record replay. A marker leads to its exact transcript entry; absence from the displayed pair does not reattach it to unrelated content or label an intentional historical reference as an ordinary orphan.
- [ ] The shared input-acceptance boundary atomically checks the reviewed base for fresh submissions. Duplicate accepted submissions return their receipt before this check.
- [ ] A newer version arriving before acceptance retains the draft and requires reviewing the updated target. The original selected quote is not replaced or relabeled.
- [ ] At actual dispatch, comparison input receives the complete latest document and an explicit revision target distinct from its source and reviewed versions. Agent-authored bytes cannot be omitted on the assumption that a session remembers them.
- [ ] Missing or busy current context holds the accepted input pending with a visible bounded failure. It cannot dispatch stale context, claim application, drop the note, or immediately redeliver. Newer readable context or explicit source reattachment is the defined recovery trigger.
- [ ] All supported driver profiles follow a specified delivery contract. A profile without that contract cannot silently claim comparison-aware continuation; its limitation is visible and covered by the RFC.
- [ ] A current-base revision appends an immutable version. A stale emission follows existing refusal/recovery and never applies an automatic reverse patch.
- [ ] Legacy notes and attachments remain readable. Full earlier versions are not duplicated into every note or into a second durable store.
- [ ] Deterministic tests cover an earlier quote with new versions arriving before send, during queueing, and during generation, plus replay, retries, queue pressure, and driver changes. The full suite passes; live-model confirmation is supplementary.
- [ ] Pointer and keyboard entry, compact layout, linked source navigation, and conversation placement are verified at the supported viewport sizes and in both themes.
- [ ] Current artifact and design contracts are updated when this ships. Prototype assets stay on their throwaway branch, and completed proposal material follows the documentation lifecycle.

## Parent

[RFC 14: Annotated content comparison](../spec.md)
