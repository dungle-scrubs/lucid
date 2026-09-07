# Annotated content comparison

Status: draft

Source: [RFC 14: Annotated content comparison](../../docs/rfc/14_annotated-content-comparison.rfc.md).

Chosen interaction: write a small note beneath the selected earlier or current passage. Submission puts that note in the separate conversation transcript and leaves a source marker. The agent revises current content; there is no direct selective rollback.

This local breakdown covers the agreed text-comparison workflow. It does not publish issues or authorize detailed image/table comparison. The recommended text-focused release boundary remains an author assumption until the user's pending scope answer. Implementation remains gated by RFC review and acceptance.

## Proposed slices

1. [Retry a browser send without duplicating its input](issues/01-repeat-safe-browser-send.md) - no ticket blockers.
2. [Read saved content changes in the artifact view](issues/02-read-content-comparison.md) - no ticket blockers; independent of repeat-safe sends.
3. [Send a historical note and revise current content](issues/03-send-historical-note.md) - blocked by the first two tickets.

Each ticket ends in a runnable user-visible behavior. The third includes source provenance, the send-time freshness check, dispatch-time context, and replay together because a partial historical-note path could target the wrong version.

Granularity is proposed by the author. No shared-tracker issues have been created. Detailed non-text comparison remains outside this ticket set pending a scope decision.

## Review and readiness

The unversioned RFC received a document-level review from `opus-5@claude`; the full message was captured before the harness timed out. Revision 1 records a disposition for all 13 findings. The author additionally verified the existing browser-ID and context-byte behavior directly in source. Neither review is runtime proof of the proposed implementation.

The three tickets match revision 1. They are local drafts, not published issues or an accepted implementation queue. The pending non-text scope answer can add a slice without changing the agreed text-note workflow.
