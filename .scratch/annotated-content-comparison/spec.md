# Annotated content comparison

Status: resolved (implementation in working tree)

Source: [RFC 14: Annotated content comparison](../../docs/rfc/14_annotated-content-comparison.rfc.md).

Chosen interaction: write a small note beneath the selected earlier or current passage. Submission puts that note in the separate conversation transcript and leaves a source marker. The agent revises current content; there is no direct selective rollback.

This local breakdown covers the agreed text-comparison workflow. The user approved the text-focused release boundary on 2026-09-07, with explicit non-text coverage limits and saved-version inspection, then directed continuation of the proposed three-ticket implementation. Detailed image/table comparison is outside this release.

## Implementation slices

1. [Retry a browser send without duplicating its input](issues/01-repeat-safe-browser-send.md) - resolved; endpoint, recovery controller, and controls verified independently before comparison entry is enabled.
2. [Read saved content changes in the artifact view](issues/02-read-content-comparison.md) - resolved; readable comparison and browser verification complete.
3. [Send a historical note and revise current content](issues/03-send-historical-note.md) - resolved; historical notes, current-document dispatch, and recovery connected.

Each ticket ends in a runnable or independently verifiable behavior. The first verifies browser recovery through the real input boundary before comparison entry is enabled. The second delivers passive comparison. The third includes source provenance, the send-time freshness check, dispatch-time context, and replay together because a partial historical-note path could target the wrong version.

The user approved continuation with the recommended three slices. Tickets 01 and 02 have no ticket blockers; ticket 03 is blocked by both. Each is intended for one fresh implementation context, using the RFC as the detailed contract. Ticket 03 is the largest because it closes one complete note-to-revision path across the supported delivery adapters. Internal changes remain within the slice whose behavior they support.

RFC revision 4 is Accepted. No shared-tracker issues have been created. Detailed non-text comparison is outside this ticket set and the approved first release.

## Review and readiness

The unversioned RFC received a document-level review from `opus-5@claude`; the full message was captured before the harness timed out. Revision 1 records a disposition for all 13 findings. The author additionally verified the existing browser-ID and context-byte behavior directly in source. Neither review is runtime proof of the proposed implementation.

RFC revision 4 answers the [revision-3 review](../../docs/rfc/14_annotated-content-comparison.review-revision-3.md) with cause-specific held-input explanations and recovery guidance. All three local tickets are aligned with revision 4, including recovery storage, held-input scheduling and explanations, retained draft placement, exact queue guards, comparison coverage, and verification. All three tickets are resolved in the working tree. Current reference docs now own the implemented behavior. The revised RFC and reviews remain until the implementation is committed; remove them with that landing, preserving the revised specification in Git first.
