# Active RFCs

RFC 24 implements [Claude startup across compatible updates](24_claude-startup-across-compatible-updates.rfc.md)
in local HCN and Lucid branches. Test seams and order are confirmed. Published
HCN dependency integration and fixture capture remain open, so the RFC stays active.
RFC 23 is already allocated to portable artifact files on a separate branch.

RFC 22 is implemented. HCN owns executable compatibility; Lucid consumes
operation results without runtime version policy. The current contract is
[HCN operation feedback](../compatibility.md).

RFC 21 is implemented.
Its completed proposal, review, and tickets are preserved in commit `b0562e3`.
Current appearance contracts live in [artifacts](../artifacts.md#application-and-artifact-appearance)
and [the design reference](../design.md).

RFC 20 is implemented. Its proposal, review, and four resolved tickets are
preserved in commit `aacacfe`. Current contracts live in
[agent compatibility feedback](../compatibility.md).

RFC 19 implements [Codex native context management](19_codex-native-context-management.rfc.md)
in the local build. Published dependency integration remains separate.

RFC 18 is implemented. Its proposal, review, and resolved ticket are preserved
in commit `61393f5`. Current projectless workspace contracts live in
[architecture](../architecture.md) and [drivers](../drivers.md).
RFCs 14 and 15 are implemented. Their final proposals, reviews,
and resolved local tickets are preserved in commit `743a48c`. Current contracts
live in the [documentation index](../README.md).

RFC 17 is implemented. Its proposal, review, and ticket are preserved in
commit `000381b`; its current contract is in [the design reference](../design.md#conversation-panel-visibility).

Current reading-view design is listed in the
[documentation index](../README.md#browser-design).

The highest allocated RFC number is **24**. The next RFC is **25**.
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
