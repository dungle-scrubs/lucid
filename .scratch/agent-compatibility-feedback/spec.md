# Agent compatibility feedback

Status: draft
Publication: local only
Source: [RFC 20, version 2](../../docs/rfc/20_agent-compatibility-feedback.rfc.md)
Review: [RFC 20, version 1 review](../../docs/rfc/20_agent-compatibility-feedback.review-v1.md), answered by the source revision.
Breakdown: machine-made recommendation; granularity confirmation pending.

## Scope

Explain compatibility warnings and errors between Lucid, its selected HCN
installation, and the selected harness or operation. The user updates the
identified installation, restarts the owning runtime, and tries again through
existing controls. RFC 20 version 2 owns the complete contract.

The scope is settled for drafting. The RFC remains Draft, and this ticket set
does not implement it or change its acceptance status. There is no parent
tracker issue to modify. All four tickets are local drafts; none is published.

## Tickets

| Ticket | Blocked by | End-to-end delivery |
|---|---|---|
| [01 - Explain HCN installation checks in the CLI](issues/01-cli-installation-feedback.md) | None | An HCN-backed command identifies the selected installation and explains a pin warning or existing initialization refusal. |
| [02 - Show startup compatibility feedback in the browser](issues/02-browser-startup-feedback.md) | 01 | Hub and direct artifact entry show accessible startup notices while records remain readable. |
| [03 - Explain compatibility of the selected driver](issues/03-selected-driver-feedback.md) | 02 | Opening or changing a managed driver shows selection-specific harness and model feedback without repeated diagnostic probes. |
| [04 - Explain execution and recovery refusals](issues/04-execution-recovery-feedback.md) | 02 | Actual worker, handshake, and recovery failures explain their own evidence while preserving execution and recovery rules. |

01 supplies the common installation facts and safe explanations through a
working CLI route. 02 brings that route into the browser and supplies the
shared notice and announcement behavior. 03 and 04 use those contracts but do
not require each other's behavior. No separate prefactoring ticket is needed:
the existing harness boundary is retained and the first slice proves its
additive facts through an actual command.

## Completion rules

Each ticket includes deterministic verification, its applicable browser or CLI
demonstration, current contract documentation, and the repository's check and
build gates. Package and compiled-distribution evidence belongs in the first
two tickets. There is no deferred testing or documentation ticket.

Keep execution admission, error classifications, durable outcomes, preferences,
and existing input recovery unchanged. Diagnostics add no updater, refresh
control, automatic model switching, model calls, or artifact-creation probe.
Use fake HCN processes to verify this feature; a live model is not required.

## RFC coverage

| Contract or review response | Ticket ownership |
|---|---|
| Pin versus floor, exact identity, resolver provenance, safe facts; F5, F11, F12 | 01 |
| Packaged and compiled release pin; current-pin documentation F13 | 01, browser distribution proof in 02 |
| Nonblocking startup, shell defaults request, notice placement, announcements; F1, F2, F4 | 02, reused by 03 and 04 |
| Managed selection memo and saved interactive exclusion; F8 | 03 |
| Runtime versus admission evidence; F7 | 03 retains runtime evidence; 04 explains actual admission evidence |
| Existing recovery refresh and actions; F3 | 03 preserves separation; 04 improves existing reasons |
| Handshake identity and outer refusal outcomes; F6 | 04 |
| Safe existing messages; F9 | 01 common formatting; 02 initialization; 03 selection; 04 execution/recovery |
| Observation origin/time and later worker success; F10 | 02 retained notice; 04 worker evidence and combined scenario |

## Comments

The source and relevant ADRs were read for this breakdown. Existing code
exploration from the RFC and review informed the slices; it does not prove the
unimplemented behavior. The version 2 structural and link checks passed during
revision; version 2 has not received a separate independent review.
