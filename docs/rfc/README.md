# Active RFCs

RFC 19 implements [Codex native context management](19_codex-native-context-management.rfc.md)
in the local build. Published dependency integration remains separate.

RFC 18 proposes [conversations without a project](18_conversations-without-a-project.rfc.md).
RFCs 14 and 15 are implemented. Their final proposals, reviews,
and resolved local tickets are preserved in commit `743a48c`. Current contracts
live in the [documentation index](../README.md).

RFC 17 is implemented. Its proposal, review, and ticket are preserved in
commit `000381b`; its current contract is in [the design reference](../design.md#conversation-panel-visibility).

Current reading-view design is listed in the
[documentation index](../README.md#browser-design).

The highest allocated RFC number is **19**. The next RFC is **20**.
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
