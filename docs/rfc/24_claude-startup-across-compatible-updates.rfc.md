---
number: 24
title: "Claude startup across compatible updates"
type: protocol
status: Accepted
author: Codex
date: 2026-09-10
version: v3
---

# RFC-24: Claude startup across compatible updates

## Abstract

Compatible Claude Code updates currently prevent ordinary Lucid artifact startup because HCN requires an exact verification version before context accounting. HCN will judge Claude headless-turn operations by their contracts and results, while Lucid will let Claude manage existing native history for turns that import no recorded history. Imported history retains bounded accounting, summaries, and access to its complete source. The conversation record, native identity, and recovery protections remain authoritative, including when native execution rejects oversized incoming content.

## Introduction

The user approved this scope on 2026-09-10 in [Choose the startup and history-protection contract](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/149). This RFC specifies that decision across HCN and Lucid. The user invoked implement on 2026-09-10 after the draft and its remaining limitation were presented. This authorizes implementation and local reviewed commits; publishing, releases and deployment remain separate.

The observed failure is New artifact, No project, Claude Code, short prompt. Lucid-selected HCN 0.6.5 refuses accounting with `unverified-adapter`: Claude is 2.1.267 and its descriptor anchor is 2.1.263. The same binaries complete synthetic fresh and resumed tasks, and the unchanged accounting adapter works below the version gate. A separate Lucid control shows that universal preflight can hold even a tiny continuation when native occupancy fills the budget, preventing the turn in which native compaction can run. The research references record the conditions and limitations of these observations.

Fit: Kevin creates and continues artifacts across coding agents. Lucid owns a durable conversation record and its rendered artifact. HCN normalizes harness differences and supervises one process. Per-operation HCN support and Lucid's context routing serve those purposes and hold product scope. Retaining a hold for imported history that cannot fit an already-full native session is the explicit boundary approved by the user.

Out of scope: automatic package changes, version ranges as compatibility policy, conversation storage in HCN, automatic retry or model switching, automatic replacement sessions, transcript rewriting, lossless model recall after compaction, and new compaction/transfer orchestration. Persistent sessions and existing Codex native-management behavior retain their current policy. The uncommitted diagnostic patch is separate work, not this fix.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Compatible operation:** the selected executable accepts the supported invocation and produces a valid result for that operation. Success does not certify every operation, model, or future turn.
- **Verification anchor:** the descriptor's `verifiedAgainst` and associated evidence. This describes a tested baseline, not an admission rule.
- **Imported history:** entries in the locked context capture's `history`, after applying confirmed coverage for the target native session. This includes missing history when returning from another harness and history for an explicit fresh continuation.
- **Mandatory content:** current artifact/comparison material and request guidance, plus the separate pending accepted input. These bytes are retained in either preparation route.
- **Native context management:** the harness's handling of its own growing session, including automatic compaction. It does not imply that arbitrary incoming content fits.
- **Prepared execution fence:** Lucid's existing validation of captured input, source range, epoch, artifact heads, settings and folder revisions, and executor ownership immediately before recording an attempt.
- **Hold:** a preparation failure before an attempt starts. A dispatched failure or uncertain attempt is a distinct durable outcome.

## Protocol Overview

### HCN Claude operation authority

For the Claude headless-turn operations in scope, HCN MUST separate executable resolution, supported invocation, context accounting, and task completion. A missing, different, or unreadable version string MUST NOT itself refuse a compatible operation. Changes to shared helpers MUST preserve other harnesses' current admission policy and persistent-session admission. The operation and mode MUST remain explicit through those helpers. Harness-specific facts stay in descriptors under HCN's existing layer boundaries. Changing other admission policies requires separate evidence and scope. The verification anchor remains evidence metadata and continues to serve descriptor maintenance. This RFC does not re-verify the whole descriptor or bump that anchor.

For Claude headless-turn runtime resume inspection, `supported` MUST mean HCN can express the documented resume invocation for the requested selection with a resolved executable. It MUST NOT claim the saved session exists or that recall succeeded. HCN MUST validate applicable invocation options. Unsupported options or a missing executable retain their actual operation result. The subsequent native resume and its identity/error stream determine whether continuation succeeds. The inspector MUST NOT create a session or send a model prompt to certify resume support.

HCN's Claude accounting operation MUST attempt the documented non-query control protocol when its adapter and requested options are supported and its executable resolves. It MUST NOT depend on the general resume support verdict, including for fresh input. Version metadata collection MUST NOT gate or turn successful accounting into failure. A version equal to the anchor MUST NOT override a malformed or failed operation.

Accounting MUST retain initialization, non-query staging, matching replay acknowledgment, and subsequent usage validation. It MUST validate request identifiers, required finite nonnegative token values and their valid relationships, window/input-limit shape, model identity, and actual executable provenance. Window and input limit MUST be positive, with input limit no greater than window. Total tokens MAY exceed either limit; that is valid over-budget accounting, not malformed evidence. A usage response is provisional until bounded child shutdown and output processing settle. The following classification applies throughout that lifetime, including output received after usage and before stream settlement.

| Native inspection frame | Required treatment |
| --- | --- |
| Matching `control_response` success in the expected state | Advance the control exchange only after validating its operation-specific payload. |
| Matching staged `user` replay acknowledgment | Advance staging; a different acknowledgment cannot advance it and is bounded by the existing deadline. |
| Top-level `system` with subtype `init`, `hook_started`, `hook_progress` or `hook_response` | Permit as initialization/hook lifecycle metadata. These frames alone neither authorize usage nor prove an assistant turn occurred. Hook metadata is not a task verdict. |
| Top-level `command_lifecycle` | Permit as control lifecycle metadata, before or after provisional usage; it is not a `system` subtype. |
| Top-level `rate_limit_event` with known `rate_limit_info.status` | `allowed` and `allowed_warning` are permitted. `rejected` yields unavailable/limit. Missing or unknown status is unavailable/protocol. |
| `result` with success subtype and finite numeric `num_turns` equal to zero | Permit as staging completion. Aggregate cost or usage need not be zero; those values are not proof of assistant execution. |
| Error result or failed control response | Preserve its native/operation failure; never produce available accounting. |
| Result with missing, invalid, negative or positive turn count | Unavailable/protocol; success must establish zero query turns. |
| `assistant`, assistant `stream_event`, or task tool-execution frame | Unavailable/protocol; terminate and settle the child even if usage was already received. |
| Other unclassified top-level frame or system subtype | Unavailable/protocol. New fields on a permitted frame are additive metadata, but an unknown event category is not assumed safe. |

This is an explicit inspection protocol boundary, separate from ordinary task NDJSON, whose unknown events continue to pass through. Unknown future inspection semantics can require an adapter change; ordinary native startup does not depend on that optional accounting exchange. For the bounded route, an unclassified inspection event yields a protocol-specific accounting hold, not a capacity diagnosis. Adapter maintenance can be necessary to support new inspection semantics, followed by explicit Retry. A different version string alone never causes that hold. Native auth/limit stderr classifications, failed control/result responses and unexpected native exits retain their actual operation failures. An exit caused by HCN's deliberate shutdown after provisional usage is not by itself a native failure. Forced output disposal before the streams drain makes accounting unavailable/cleanup; a partial drain cannot finalize available accounting. Output validation cannot certify events an executable never emits.

The selected path MUST be resolved for the operation and used for that child. Available accounting MUST describe that child and its measured model, not an earlier probe of another executable. Lucid MUST retain its path/model agreement checks before using accounting. Path identity is not a claim of immutable executable bytes; no persistent compatibility cache or binary fingerprint registry is introduced. Cancellation, deadlines, output bounds, child termination and settlement remain in the process owner.

Resume accounting MUST retain forked, non-persistent inspection rather than write staged content into the source session. Failed or incomplete protocol exchanges yield unavailable accounting. They never authorize task dispatch through the native route.

### Lucid preparation selection

Lucid MUST derive the route from HCN's explicit context-management declaration, requested mode, and the locked context capture. It MUST NOT infer eligibility from harness name, version, model capacity, character count, a failed accounting operation, or a missing capability.

For the new declaration specified below, native preparation is eligible only in `headless-turn` and only when captured imported history is empty. This applies both to an ordinary first prompt and to a continuation whose record history is already confirmed for the intended native session. The empty-history test is conservative: queued input during a prior turn can leave a same-session output tail beyond the confirmed boundary; a failed attempt can leave partial output and failures; an earlier held input can also appear in the capture. These are imported history for this contract even when some bytes are already in the native transcript. They MUST take bounded preparation and can retain the full-session hold. Merely knowing that the harness produced an event is not proof of complete native coverage. This RFC does not expand native eligibility for these cases.

A fresh task requires no resume support. A resume retains the supported-invocation check, exact saved native identity, route, and working folder.

Eligible native preparation MUST render the complete captured request, retain its offered full source copy and attachment lifetime, and return accounting and summary as null. It MUST cross the same prepared execution fence. It MUST NOT count existing native occupancy as a prerequisite to dispatch. Current artifact size does not change eligibility: oversized mandatory content can fail during native execution and stays preserved in the record. HCN still validates and passes the selected model. Observed model agreement is not measured before dispatch on this route. Selecting a smaller-window model on the same native session with empty imported history therefore dispatches natively and can compact or fail; it does not create a preflight capacity hold. With imported history, the changed model retains full accounting and agreement checks.

When imported history is nonempty, Lucid MUST use its existing bounded context preparer. This includes first use of a harness after prior conversation, returning after another harness contributes, unconfirmed context gaps, and explicit fresh recovery. It MUST preserve source IDs, authorship, roles, interrupted/failure state, current mandatory content, recent messages, summary provenance and notices, and full-source retrieval. It MUST recount the complete final rendered prompt, including native occupancy on resume. Unknown or unprojectable content remains a hold before either route.

Existing bounds remain: at most six passes, 64 summary operations, 256 accounting requests, 16,000 characters per summary output, and a 300-second deadline per summary operation. These bounds govern preparation resources, not token estimates. Any nonempty imported history, including same-session unconfirmed tails, can still hold when accounting and bounded summaries cannot establish room in a full native session. Such an E-HUB-06 capacity hold offers Retry, but unchanged state can produce the same hold indefinitely. No guaranteed in-session recovery or fresh-continuation action for that hold is added. Later inputs can also remain held because they capture the earlier unconfirmed content. This remaining inability to continue in the same native session is an explicit limitation of the scoped fix, not a successful recovery claim. Lucid MUST NOT compact a fork, split delivery into hidden turns, or discard history to get past that hold.

Native compaction preserves neither every active instruction nor exact recall. The canonical Lucid record and offered source are unchanged by compaction. Existing offer/confirmation rules remain: only valid successful terminal evidence can confirm context for the actual native session. An offer, echoed requested ID, compaction boundary, or count alone is insufficient. A resumed identity mismatch MUST leave coverage unconfirmed under existing handling. Missing session or uncertain execution MUST retain existing explicit recovery; no automatic second task call follows.

## Message Formats

HCN remains a CLI subprocess. Existing inspection JSON and task NDJSON remain the transport. This RFC adds one closed capability kind, not a command or a new event kind.

| Surface | Required meaning |
| --- | --- |
| `nativeContextManagement: { kind: "native-session-auto-compaction", modes: ["headless-turn"] }` | New Claude declaration: native preparation is eligible only when imported history is empty. |
| Existing `{ kind: "auto-compaction", modes: ["headless-turn"] }` | Existing Codex contract stays unchanged, including its current complete-prompt native route. This RFC makes no new claim about Codex admission guarantees. |
| Missing, null, malformed or unrecognized declaration | No native authorization; retain bounded preparation. It succeeds if accounting and fit succeed, and otherwise retains the actual operation-specific hold. |
| Runtime `resume.status` and `resume.reason` | Retain the existing supported/unknown shape; document the Claude supported-invocation meaning above. An actual resume is separate evidence. |
| Available accounting | Retain its current shape and measured model/executable identity. A valid operation result authorizes bounded preparation, not arbitrary later requests. |
| Native prepared result | Existing accounting-null and summary-null form; the full offered context and execution stamp remain required. |
| Native compaction progress | Existing progress label `compact_boundary`; this is activity, not durable coverage acknowledgment. |

For the new kind, the only recognized mode list is exactly `["headless-turn"]`; duplicates, additional modes and unknown modes make that declaration ineligible. The existing kind retains its current mode-superset decoding. Lucid's harness facts MUST preserve the distinction between the two known kinds through preparation rather than collapsing both to the existing boolean.

The new kind prevents an older Lucid from treating the Claude declaration as the existing unrestricted native route. Lucid MUST validate the whole declaration and recognize only known kind/mode combinations. A decoder that cannot recognize it MUST leave native authorization absent and use its existing bounded preparation path. Unknown kind alone is not an operation failure, and it is never treated as `auto-compaction`. The declaration is a curated descriptor fact, not a runtime observation that compaction is enabled. HCN's descriptor documentation and CLI contract MUST state that meaning; no provenance field is added to the wire format. Actual accounting remains an operation result. Disabled native auto-compaction is not separately detected on the native route: execution can fail, after which the failed-attempt history follows the conservative bounded route above. Repairing the native setting does not itself authorize replay or guarantee a later bounded preparation will fit. No version fields return to Lucid's diagnostic API.

## State Machine

Evaluate common route/resume/capture guards before either route-selection row. Run accounting only after selecting bounded preparation. After readiness, recheck the fence before recording an attempt.

| State | Condition | Next state and durable effect |
| --- | --- | --- |
| Accepted input | Executor owns the record and capture succeeds | Preparing; no task dispatched. |
| Preparing | Invalid route, missing required resume support, or unprojectable context | Hold; input and preferences retained. |
| Preparing | New declaration, correct mode, empty imported history | Ready with complete request, accounting null and summary null. |
| Preparing | New scoped declaration with imported history, or no eligible native declaration, after common guards pass | Bounded preparation; no native task dispatched. |
| Preparing | Existing `auto-compaction` declaration eligible under its unchanged policy | Existing native ready result, including its existing imported-history behavior. |
| Bounded preparation | Valid fitting accounting | Ready with the complete prepared request. |
| Bounded preparation | Unavailable accounting or no fit after bounded preparation | Hold with the specific operation or capacity reason; input retained. |
| Ready | Fence, folder or executor validation fails | Existing stale/refused preparation result; no attempt consumed. |
| Ready | Fence succeeds | Attempt recorded, then selected native task dispatched. |
| Attempt recorded, dispatch not called | Conclusive existing `dispatch-not-called` evidence, such as cancellation before dispatch | Existing `pre-start-failed` settlement; preserve input and offer explicit recovery. This is distinct from a hold and from uncertain dispatch. |
| Attempt | Valid successful terminal and identity evidence | Existing settlement and eligible coverage confirmation. |
| Attempt | Native failure | Failed attempt with input and partial output preserved. |
| Attempt | Process loss without conclusive terminal evidence | Uncertain; existing explicit recovery required. |

A held E-HUB-03/E-HUB-04 input becomes eligible through existing explicit recovery or a material settings/folder/native-session prerequisite change. E-HUB-06 requires explicit recovery. Installing HCN changes none of those prerequisites.

The attempt is recorded before dispatch, so a crash between those actions without conclusive non-dispatch evidence remains uncertain. Cleanup MUST finish before executor ownership is released. Opening an artifact or reading the record MUST NOT dispatch work. A prior held input MUST NOT be silently replayed by installing this change.

## Error Handling

Use existing HCN accounting outcomes, refusal issue codes, failure classes and Lucid operation diagnostics. No synthetic version failure is added.

| Failure | Required handling |
| --- | --- |
| Unexpressible operation or missing executable | Structured operation refusal/unavailability with safe explanation; retain selected settings and input. |
| Malformed counts or unexpected query activity | Accounting unavailable/protocol; terminate and settle the child; no available result can follow. Unmatched acknowledgments cannot advance the exchange and remain subject to its deadline. |
| Auth, provider, native exit, transport, timeout or cancellation during accounting | Preserve the operation failure and hold bounded preparation. |
| Model/path disagreement during accounting | Hold; never reuse the result for the changed selection. |
| Oversized pending input, mandatory artifact, native byte limit, disabled/failed compaction | On native route, preserve the failed or uncertain attempt according to actual terminal evidence. On bounded route, preserve its hold if no fit is established. |
| Missing/corrupt native session or refused resume | Preserve input, actual failure and native-session intent; existing explicit recovery only. |
| Generic native transport failure | Report the operation and safe known cause. Do not infer token overflow or a specific byte limit without structured evidence. |

HCN MUST retain any structured size/compaction cause it actually receives. Lucid MUST expose HCN inspection diagnostics through the current compatibility notice. Preparation holds retain their current hold/recovery presentation, and dispatched native failures use the transcript's existing failure/recovery surface. Each uses bounded safe explanations. Selected executable resolution belongs in installation/operation detail where appropriate; per-turn native failures MUST NOT be recast as once-per-document compatibility notices. Raw stderr, credentials, configuration bodies and native session IDs MUST NOT become diagnostic details. If native cause is unavailable, the generic operation failure is accurate and sufficient.

Automatic task retry count is zero, including when an HCN failure has `retryable: true`. After integration, an existing `unverified-adapter` E-HUB-03 hold or capacity E-HUB-06 hold is retried with the existing Retry action, preserving its accepted input ID and taking a new locked capture. Any full-session imported-history hold, including a same-session unconfirmed tail, can recur indefinitely. Retry reevaluates; it does not compact the native session. There is no additional recovery action for that capacity hold in this change. A failed/uncertain attempt follows its existing recovery policy, including acknowledgment of possible effects and explicit fresh continuation only where that policy offers it. Existing user recovery actions retain accepted input identity; neither a dependency update nor a page reload authorizes a new attempt. No model substitution, truncation, or new session is a capacity repair.

## Security Considerations

Native executables are trusted local programs with the user's existing permissions. Removing a version gate does not isolate an incompatible binary. Output validation can detect unexpected inspection execution but cannot undo effects already performed. Inspection MUST retain the documented non-query contract, fork/non-persistence controls, existing permission choices, bounded I/O and cleanup. Synthetic tripwires use isolated test sessions and restricted tools; those probe settings MUST NOT silently replace real accounting settings and invalidate its measurement.

History remains quoted data with roles and provenance, not instructions that can select a preparation route. Record credentials and protocol identity envelopes remain outside projected context. Full offered copies retain their private directory permissions, attachment identity and cleanup lifetime. No native transcript is rewritten to create space. Prompt injection remains subject to the existing trust boundary; this change grants no new tools or filesystem access.

## Versioning

For the Claude operations in scope, compatibility is per operation, not a version equality or range. `verifiedAgainst`, version source, fixtures, and descriptor tripwires remain maintenance evidence. Additive capability kinds remain closed for readers: unknown is not support. Runtime resume support is explicitly documented as invocation support; native success is still required.

Lucid's exact HCN package pin and recorded fixtures remain build inputs. Implement Lucid's recognition and routing with synthetic HCN contracts before integrating an HCN release that declares the new kind. Old HCN yields today's behavior; newer HCN on old Lucid MUST retain bounded preparation for the unknown declaration, succeeding only when its accounting and fit succeed. Verify the pairing against Lucid baseline `61733ba`, whose unknown-kind decoder retains bounded preparation, and against the supported release at integration time. Record the release tag/commit used. An executable override or PATH fallback can expose this pairing despite the normal dependency pin. Installed Claude updates that retain required native operations then require no further HCN release merely because the version changed.

This RFC proposes a new kind because adding an optional restriction to the old kind lets old consumers ignore it and bypass history preparation. Changing every existing native route would alter Codex behavior outside scope.

## Implementation Notes

Local implementation status, 2026-09-10: the HCN operation slice and Lucid
history-routing slice are implemented and reviewed. The integrated local build
passes both product gates and live startup, resume, compaction and transfer
checks. Source retrieval remains subject to native tool permissions; an explicit
read grant was used for its separate live check. The HCN dependency release,
Lucid pin update and release-specific fixture capture remain open. This RFC and
its reviews remain active until that integration is complete.

### Ordered handoff

1. HCN owners deliver operation-based Claude resume/accounting behavior and inspection execution guards, with CLI evidence and skill audit. This is independently useful to all HCN callers and does not yet declare the new native capability.
2. Lucid owners deliver recognition of the new kind and captured-history routing, with deterministic tests through the existing HCN subprocess seam. The released old descriptor keeps current behavior until integration.
3. HCN and Lucid owners deliver the declaration and consuming dependency/fixture integration after both prerequisites. Verify the full user flow and failure/transfer cases, then use the normal release workflow. The intermediate operation-only HCN build remains suitable for CLI tests, but this handoff performs a single Lucid dependency/fixture integration in step 3. An earlier consumer release is outside this ticket sequence. No installs or deployments occur in this planning map.

Rollback uses a deliberate dependency/build rollback without rewriting records, native sessions or accepted inputs. Older software can restore the previous hold, not erase the failed attempt. Preserve the existing diagnostic patch during integration and review it separately for duplication or conflict with current operation feedback.

### Regression evidence required

| Area | Deterministic requirement | Targeted live confirmation |
| --- | --- | --- |
| Compatible updates | Different version with valid operation succeeds; matching version with broken operation fails. Unusable version metadata cannot block a valid operation. | Pin the built HCN for tests, then run it against an installed Claude different from its anchor; record both resolved paths. |
| Accounting | Fresh and forked resume; wrong IDs, invalid counts, unexpected assistant/tool/positive-turn result, zero-turn success with zero and nonzero aggregate usage, each permitted lifecycle frame before and after usage, allowed/allowed-warning/rejected rate-limit status, error result, missing/non-numeric turn count, unknown top-level frame and unknown system subtype, post-usage assistant activity, forced incomplete drain, model/path mismatch, timeout, cancellation, output bounds and cleanup. | Staged-size sensitivity with identical model/settings; source-session hash unchanged across forked accounting. |
| Ordinary startup | Empty imported history selects native route without a count; missing/malformed capability never does. Stale capture/ownership still refuses dispatch. | New artifact, No project, Claude, short prompt: one task starts and a complete artifact renders with no compatibility hold. |
| Continuation | Native occupancy cannot force preflight for an eligible turn. Queued notes, prior failed attempts and earlier held inputs with unconfirmed history take bounded preparation. Missing/corrupt session, identity mismatch and uncertain attempts preserve recovery rules. A smaller-capacity model dispatches on the eligible native route and either completes or records native failure without automatic replay. | Recall after process loss and after native compaction, same native ID. A lowered threshold tests the compaction path, not full-capacity guarantees. |
| Imported history | First use, return after another harness, explicit fresh continuation and unconfirmed gaps all use bounded preparation. Verify source IDs, roles, recent constraints, comparison/current content, summary notice and full-source retrieval. Near-full native occupancy retains the approved hold. | Synthetic cross-harness transfer that requires preparation, followed by correct source/constraint recall; confirm full source remains retrievable. |
| Failures | Oversized input/artifact, byte failure, disabled/failed compaction, auth/provider failure and transport uncertainty retain input and clear errors; assert no automatic second task call. | Oversized-byte attempt and one native failure with preserved accepted input; distinguish measured cause from generic transport failure. |
| Existing holds | Seed `unverified-adapter` E-HUB-03 and capacity E-HUB-06 holds. Integration/reload alone never dispatches; explicit Retry preserves input identity and reevaluates preparation. Repeated Retry and later input preserve a full-session hold when the same unconfirmed history still cannot fit; no fresh-continuation action is added to that hold. Its diagnostic distinguishes capacity from unavailable inspection. | Retry a synthetic previously held startup input after integration and verify one attempt, preserving its original input identity. |
| Compatibility | HCN tests separately prove Codex, pi and Muse resume admission and all persistent-session admission remain unchanged when the shared helper changes. Existing Lucid Codex and persistent-session paths remain unchanged. Older reader/new declaration cannot take the broad native route. Unknown NDJSON kinds still pass through. | Record selected HCN binary, package/fixtures and settings used by the browser flow. |

HCN's full Node/Bun gates, build/package validation, and source hcn skill claim scripts MUST pass against the changed binary. Lucid's full check and compiled build MUST pass. Re-capture dependency fixtures from the intended HCN build/release; label synthetic negative sequences as synthetic. Keep live evidence in ignored artifacts unless consumed by a test. The prior diagnostic patch's 1,425 passing tests and browser check are historical evidence of that patch only, not validation of this change.

## Review disposition

The v2 revision answered the [Claude Opus 5 review of v1](24_claude-startup-across-compatible-updates.review-v1.md). The review used direct source reads and did not execute tests; the driving session ran the structural validator.

| Finding | Disposition |
| --- | --- |
| F1 | Clarified conservative eligibility for queued notes, failed attempts and earlier held inputs. All unconfirmed captured history retains bounded preparation, even for the same session; added tests and disclosed the remaining hold. Expanding coverage inference is outside this approved change. |
| F2 | Scoped version-policy change to Claude. Shared-helper changes preserve other harness admission policies; existing Codex native preparation remains unchanged. |
| F3 | Added explicit inspection-frame classification, malformed/error result handling and post-usage validation through child settlement. Removed zero aggregate usage as an admission rule. Unknown top-level semantics fail the inspection protocol; additive fields remain permitted. |
| F4 | Named existing Retry for prior E-HUB-03/E-HUB-06 holds, retained input identity, and added upgrade/retry evidence. No install-triggered wake. |
| F5 | Chose one consumer integration, named baseline 61733ba and required the supported release to be identified at integration. |
| F6 | Defined exact new-kind modes and preserved the distinction through Lucid's harness facts; existing-kind decoding remains unchanged. |
| F7 | Located curated provenance in descriptor/CLI documentation; no undefined wire field is required. |
| F8 | Stated that disabled auto-compaction is not probed, native failure is possible, and a later failed-attempt history can still hold. No new settings detector. |
| F9 | Specified smaller-model dispatch/failure and the absence of pre-dispatch observed-model agreement on the native route. |
| F10 | Ordered guards, included conclusive non-dispatch settlement, and stated hold wake rules. |
| F11 | Separated preparation notices from per-turn transcript failures. |
| F12 | Used the compatible-operation term. Allocation was checked across Git history: RFC 23 exists on the portable-artifacts branch. The planning worktree index is updated to 24/25; the reviewer read an older index view. |

The v3 revision answers the [Claude Opus 5 review of v2](24_claude-startup-across-compatible-updates.review-v2.md):

| Finding | Disposition |
| --- | --- |
| R1 | States that unconfirmed history can leave a full native session held indefinitely, Retry and later inputs can repeat the hold, and no new in-session or fresh recovery action is added. Adds matching regression requirements. |
| R2 | States that new inspection semantics can require adapter maintenance and explicit Retry. Requires a protocol-specific hold reason, distinct from capacity. |
| R3 | Separates common guards, route selection and bounded-route accounting/failure. Native selection never requires a count. |
| R4 | Splits top-level command lifecycle from system subtypes, names operation failure evidence, and adds positive lifecycle and detailed negative controls. Preserves allowed rate-limit warnings from the existing HCN stream contract. Clarifies deliberate shutdown versus unexpected exit and rejects incomplete output drain. |
| R5 | Unknown declarations leave native authorization absent. Bounded preparation can succeed; the declaration does not itself cause failure. |
| R6 | Scopes the abstract and HCN change to Claude headless-turn operations and adds HCN tests for other harnesses and persistent admission. Direct source verification confirmed persistent inspection uses the shared helper, so its mode remains explicit. |

Both reviews report source/document evidence rather than executed product tests. The driving session checked graph coverage for material source paths and read stale/missing ranges directly. The product regressions remain implementation requirements.

## Open Questions

The user authorized implementation on 2026-09-10 by invoking implement after receiving the v3 draft and its disclosed full-session limitation. The accepted empty-imported-history boundary retains native failure for oversized mandatory content and bounded holds otherwise. The user confirmed the proposed seams and order by instructing autonomous continuation. Shared publication, release and deployment are not authorized by this invocation.

## References

### Normative

- [Drivers](../drivers.md) - current context, session, dispatch and recovery contracts; this RFC changes only the stated preparation selection and HCN support policy.
- [HCN operation feedback](../compatibility.md) - operation authority and safe error presentation.
- [HCN boundary ADR](../adr/0005-hcn-owns-harness-differences.md) - ownership across the subprocess boundary.
- [Preference and observed state ADR](../adr/0009-a-preference-is-not-an-event-or-a-claim-about-reality.md) - preserve user selection separately from observed behavior.
- [Choose the startup and history-protection contract](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/149) - approved scope and decision record.

### Informative

- [Operation research](https://github.com/dungle-scrubs/harness-cli-normalizer/blob/f38cbd11a7e166766f4dbd0381ff92e59ae955f5/docs/research/2026-09-10-claude-startup/operations.md) - immutable probe evidence, protocol limitations, and linked official Claude documentation, accessed 2026-09-10.
- [Native context research](https://github.com/dungle-scrubs/harness-cli-normalizer/blob/f38cbd11a7e166766f4dbd0381ff92e59ae955f5/docs/research/2026-09-10-claude-startup/native-context.md) - four required cases, compaction evidence, and limitations.
- [Historical RFC 15 R8](https://github.com/dungle-scrubs/lucid/blob/51014fc/docs/rfc/15_local-hub-conversation-integration.rfc.md#r8-context-bounds-and-automatic-summaries) - history-protection rationale; current compatibility supersedes its version policy.
- [Original HCN inspection change](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/cd2328d) - staged non-query accounting.
- [Codex native management](19_codex-native-context-management.rfc.md) - existing behavior retained.
