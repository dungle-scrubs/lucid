# Active RFCs

RFC 34 drafts [unbound publication headless fallback](34_unbound-publication-headless-fallback.rfc.md).
It is a draft: a publication from a session with no Lucid integration releases its native requirement, and browser chat runs headless on the settings the publisher declared.

RFC 32 drafts [any-session handoff to Lucid](32_any-session-handoff-to-lucid.rfc.md).
It is a draft: any plain session supplies artifact plus continuation text, one local command creates the record and attaches, and the source holds through a 30-minute review window.

RFC 31 drafts [idle headless-session release](31_idle-headless-session-release.rfc.md).
It is a draft: a parked `headless-session` run holds presence forever and blocks queued managed work. Terminal-owned run behavior and the grace period are unresolved.

RFC 30 defines [native feedback context by reference](30_native-feedback-context-by-reference.rfc.md).
It is accepted for implementation after two Muse review passes and amends RFC 26's transport-limit rule. Claude Code is measured and enabled; Codex keeps inline-only delivery until its own slice is measured.

RFC 28 [Pi native extension bridge and verified headless resume](28_pi-native-extension-bridge-and-strict-session-locators.rfc.md) (v6) is implemented in main (#326, #329, #330, #331). A Lucid Pi extension registers the TUI session, commits Lucid commands from Pi's Bash tool, delivers browser notes as follow-up messages, and verifies the session and folder Pi opened before a headless resume reaches the model. Its activation gates passed on Pi 0.87.1. The current contract is [native Pi](../native-pi.md).

RFC 35 [Pi native settings and extension loading for bound continuation](35_pi-native-settings-for-bound-continuation.rfc.md) (v3) is implemented in main (#326, hcn 0.7.6): hcn gains a Pi settings source and an `--extension` option, and Lucid resumes a bound Pi session with a settings fingerprint and no approval channel. Without it, Lucid holds every bound Pi note before a prompt. v3 corrects RFC 28's refusal evidence: exit 3 counts on any hcn failure class.

RFC 27 defines [native approvals during headless continuation](27_native-approvals-during-headless-continuation.rfc.md).
It is accepted for implementation after two Muse review passes. Native transport and browser acceptance remain required.

RFC 26 proposes [interactive artifact conversation continuity](26_interactive-artifact-conversation-continuity.rfc.md).
It is accepted for implementation; v9 retains the user-approved startup instruction and adds the reviewed native-publication admission correction. Native integration acceptance remains required for each interface.

RFC 24 is implemented with HCN 0.6.6. The completed proposal and reviews
are preserved in commit `48461c5`. Current contracts live in
[drivers](../drivers.md#recorded-context-preparation) and
[compatibility feedback](../compatibility.md).
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

RFC 29 is implemented in main (`fix(pi): live installed model list in
settings`). Its proposal and v1 review are preserved in the merge; current
contracts live in [drivers](../drivers.md) for the store source and
served choices.

The highest allocated RFC number is **35**. The next RFC is **36**.
RFC 24 was allocated to Claude startup compatibility; RFC 25 is allocated to
automatic recovery in concurrent work. Their numbers remain reserved.
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
