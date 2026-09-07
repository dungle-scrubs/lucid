# Active RFCs

- [RFC 15: Local hub conversation integration](15_local-hub-conversation-integration.rfc.md) - Draft, revision 3; answers the [revision-1 review](15_local-hub-conversation-integration.review-revision-1.md) and [revision-2 follow-up](15_local-hub-conversation-integration.review-revision-2.md) and consolidates the [hub Wayfinder decisions](https://github.com/dungle-scrubs/lucid-v2/issues/199). The [approved eight-ticket breakdown](../../.scratch/local-hub-conversation-integration/spec.md) is published on GitHub.

- [RFC 14: Annotated content comparison](14_annotated-content-comparison.rfc.md) - Accepted, revision 4; implementation proceeds through the [three local tickets](../../.scratch/annotated-content-comparison/spec.md). Revision 4 answers the [revision-3 review](14_annotated-content-comparison.review-revision-3.md) with cause-specific queued explanations and recovery guidance. The [revision-1 review](14_annotated-content-comparison.review-revision-1.md) and [unversioned-draft review](14_annotated-content-comparison.review-unversioned.md) are also answered in the RFC.

Current reading-view design is listed in the
[documentation index](../README.md#browser-design).

The highest allocated RFC number is **15**. The next RFC is **16**.
Never reset numbering because completed files have been removed. Before
allocating, check this high-water mark, active filenames, and Git history;
use one greater than the highest number allocated and update this mark.

For work larger than a correction, the workflow is draft-rfc, review-rfc
(cross-family, excluding the family that wrote it), draft-tickets, then
implement. This retains the repository's proposal and review discipline.

Keep proposed, accepted, and partly implemented RFCs here with explicit
status. Reviews stay beside an active proposal. Do not treat the largest
filename as an instruction to implement a withdrawn or completed RFC.

On completion, update the current references and relevant [ADRs](../adr/README.md),
then remove the RFC and its reviews. Preserve unresolved work in an active
document first. Git stores the completed proposal and review history; see
[historical references](../README.md#historical-references).
