---
number: 28
title: "Pi native extension bridge and strict session locators"
type: protocol
status: Draft
author: Codex
date: 2026-09-13
version: 2
---

# RFC-28: Pi native extension bridge and strict session locators

## Abstract

Pi exposes its current conversation through an extension API, but Lucid's verified command integration currently covers Codex only. Pi can also store a session outside the directory implied by its working folder. This proposal connects the current Pi session through a bounded extension bridge and carries its captured storage location to HCN for strict resume. It refines the Pi lane of RFC 26 without enabling that lane before native acceptance.

## Introduction

This draft is parked while the verified Codex lane completes. Version 2 records a native strict-resume blocker and the unresolved v1 review; it is not accepted for implementation. The proposed bridge and locator contracts below do not establish Pi support.

The person using this is the same person reading and annotating agent-authored artifacts described in CONTEXT.md. Lucid routes a live agent conversation into a durable record and back to the current reader. Current-session delivery and exact same-session resume serve that purpose and hold the scope already accepted in RFC 26 and ticket 05. This is a machine-made proposal under the standing instruction to continue implementation autonomously.

The existing command authority uses Codex's native session/thread context. Pi's documented shell environment supplies session ID and file, but those values alone do not distinguish an interactive parent from a same-ID child or establish lifecycle generation. Pi's extension context supplies the current run mode, session manager and cancellation signal. Native acceptance, rather than a hardcoded package version, determines support.

This proposal covers Pi CLI integration, durable session locators, and HCN's Pi strict-resume operation. It does not add a general IPC server, replace Bash tools, supervise unrelated sessions, import native history into Lucid, expose model-selected ownership, or enable another interface. Native approvals and settings retain RFC 27's existing preservation requirements. Unsupported Pi settings or resume operations continue to hold feedback.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Extension capture**: identity and lifecycle context read by the trusted Pi extension from its current callback, never from tool parameters.
- **Bridge helper**: one Lucid child process invoked directly by the extension for one bounded operation. It is not a daemon or a replacement Pi session.
- **Native locator**: the exact native session-file location captured by the integration. It identifies storage, not execution authority.
- **Lifecycle generation**: RFC 26's registration generation, replaced on native session replacement and invalidated on teardown.
- **Tool operation**: one of publish, resume-listen, receipt or respond exposed by the Pi Lucid extension tool. It has the semantics of the corresponding RFC 26 command.

## Protocol Overview

1. At Pi session_start, the extension captures the current native context. Only verified TUI parent use is eligible. RPC, JSON, print, headless launch roles and unverified provenance MUST NOT register.
2. The extension directly starts a short bridge helper for registration. The helper corroborates the parent's kernel PID/start/executable identity and validates the capture before using existing registration storage.
3. The model uses a dedicated Lucid extension tool. Its parameters contain only existing public operation data. The extension captures current identity again and invokes the helper without a shell. This is the Pi equivalent of the RFC 26 CLI operations; ordinary shell environment values do not authorize these operations.
4. Resume-listen records intent and returns. After the native response ends, the extension uses agent_end's verified native cancellation signal to wait for at most 45 seconds. A missing signal or unsupported delivery transport holds feedback and does not mark the session ready.
5. The shared listener selects at most one input under the existing executor lease, records offer-started, releases that lease, and returns the full offer instruction. The extension sends that instruction into the same Pi session through sendUserMessage with follow-up delivery and template expansion disabled. Transport alone is not receipt.
6. The model invokes the receipt tool operation before work and respond afterward. Both revalidate native context, generation, offer and epoch. The next agent_end may listen again only while the existing listener intent remains enabled. Expiry or interruption requires explicit resume-listen.
7. On confirmed interactive departure, Lucid passes the stored identity, folder and locator to HCN. Existing handoff guards still govern execution. HCN validates and translates the locator; Lucid does not construct Pi flags or search Pi's session directories.

Session replacement or shutdown MUST abort pending waits and await owned helper cleanup before old callback state can be discarded. The extension MUST NOT reuse captured session-manager objects across replacement. Independent tool operations may not select work; only the existing listener owns that step.

## Message Formats

The extension tool accepts a closed tagged object. Unknown fields MUST be rejected, including identity or owner overrides.

| Operation | Public fields |
| --- | --- |
| publish | requestFile, an absolute publication request path |
| resume-listen | conversationId |
| receipt | conversationId, offerId |
| respond | conversationId, offerId, requestFile |

Existing publication and response validators retain their size limits and semantics. Tool text, artifacts and browser requests MUST NOT carry an extension capture.

The private helper request is UTF-8 JSON on a dedicated inherited pipe, bounded to 64 KiB. Model-generated artifact/response bytes stay in their existing bounded request files. The request has bridgeVersion 1, operation, public fields, and capture. Capture contains mode, nativeSessionId, nativeSessionFile when present, workingDirectory, owner PID/start/executable, and the expected registration ID/generation after registration. IDs and paths retain RFC 26's validators. The helper independently reads its direct parent's kernel identity; a mismatch or unavailable observation refuses before registration or control admission. Callback provenance is trusted only from the installed extension entry point, under the same-user native-code trust boundary below.

Helper operations and lifecycle events are closed unions. Registration is a lifecycle operation, not a tool parameter. Helpers return one bounded JSON result using existing publication/control/listener result types. A missing, malformed or lost result is unconfirmed. Receipt and response repeats use the existing exact offer/result identities; they do not select another input.

A Pi binding additionally stores nativeLocator: {kind: "pi-session-file", path: string}. The path is captured from getSessionFile(), not a requested working directory or filename convention. It is an absolute bounded path. No file at startup means storage is not yet established; capture may register the live identity, but binding/resume eligibility requires later verification. Original folder spelling remains intact, with realpath only supplementary.

HCN receives the existing native ID/cwd plus an optional --session-file PATH input for Pi operations. The harness seam owns this option. HCN MUST verify a bounded regular native Pi session header, exact ID, stored folder, and an unambiguous native lookup in that file's directory. Unsupported header formats, ephemeral storage, missing files, conflicting matches and folder refusals MUST fail before native creation. A locator does not replace exact-ID validation.

Strict resume requires the native open operation to refuse when the exact session disappears after preflight. HCN MUST NOT use --session-id, which can create a session, or a missing-path form of --session. The installed Pi 0.85.1 full-UUID --session plus --session-dir form also fails this requirement: an isolated native fault-injection run deleted the selected test file between lookup and open, and Pi reached session_start with a different native ID at the old path. The earlier successful-resume and initially-missing-ID probes do not close this race. HCN preflight alone cannot make this native form strict. The Pi launch lane therefore MUST remain unavailable until a native strict-open operation is established. HCN does not rename, copy or synthesize a session file to bypass this requirement.

HCN owns interpreter-aware launch for the verified Pi CLI entry point. It resolves the supported Node entry point and interpreter without a shell, supervises the process it actually starts, and reports that process's kernel identity. Arbitrary shebang wrappers remain unsupported. Startup prompt data uses native end-of-options handling and is never interpreted as flags. The saved model, provider, effort and supported permissions are not replaced by browser preferences.

## State Machine

The bridge has unverified, registered, requested, waiting, offered, and closed states. These are integration states; the durable host retains authority.

- unverified -> registered: eligible TUI lifecycle plus corroborated owner and accepted registration.
- registered -> requested: explicit resume-listen accepted for the exact bound record.
- requested -> waiting: matching current agent_end, non-aborted native signal, verified full-context transport, and acquired executor lease.
- waiting -> offered: durable offer-started succeeds; the helper returns its complete instruction and releases the lease.
- offered -> requested: exact receipt and terminal outcome are recorded and continuation remains enabled.
- waiting -> registered: 45-second expiry, native cancellation, signal loss or transport refusal. Readiness is revoked; accepted input remains saved or explicitly uncertain according to whether an offer was recorded.
- any live state -> closed: session shutdown/replacement, native owner loss or helper teardown. No state transition infers receipt or closed ownership from a timeout.

An unresolved offer prevents another selection. A lost helper result after offer-started remains delivery-uncertain; a later agent_end MUST NOT replay it. Native session replacement creates a new generation and requires new explicit selection. Compaction that retains the same current session is not replacement, but transport/context limits are rechecked.

## Error Handling

Existing host and HCN typed failures remain authoritative. The integration adds these setup/transport reasons:

| Reason | Behavior |
| --- | --- |
| subagent-provenance-unverified | No registration or readiness; explain that this Pi invocation cannot be verified as the interactive parent. |
| native-context-unverified | Refuse the operation; preserve publication and feedback through the existing failure boundary. |
| native-signal-unavailable | Do not enter listening; ask for explicit resume-listen in a supported native turn. |
| native-locator-unverified | Keep continuation held; verify the captured native file before resume. |
| bridge-result-unconfirmed | Read current state; do not repeat uncertain dispatch. Exact receipt/response readback remains supported. |

No error authorizes a fresh native session, a different model, arbitrary native arguments, or a global installation. A rejected Pi bridge operation cannot fall through to the ordinary managed driver. Cancellation ends only this owned wait/helper operation; it does not stop an unrelated native response.

## Security Considerations

The trusted components are the installed Pi extension, its native API context, Lucid's helper/host, and HCN's normalized native operation. Models, artifact scripts and browser payloads cannot nominate a native owner. The helper is not a public authority API; it accepts extension capture only over its direct parent-owned pipe and rejects mismatched ownership, mode, generation and bounded input.

Same-user arbitrary native code is outside the sandbox boundary: an installed extension already has full filesystem/process authority. This contract does not claim that a malicious same-user process cannot impersonate extension code. It does require independent kernel owner corroboration, native callback context, and negative native evidence for ordinary model and subagent invocation. If that distinction cannot be established for the installed Pi integration, the adapter remains unavailable rather than treating absent markers as parent proof.

The helper MUST acquire registration locks before record append locks and MUST use existing host controls. It neither imports a second lock backend into Node nor owns a second mapping of session-to-record authority. Native file paths are private record metadata, not rendered credentials or browser-controlled launch inputs. No environment values, credentials or native history are copied into diagnostics. Only the identified session's header is needed for locator validation; native history stays with Pi.

## Versioning

Bridge version 1 is a private closed protocol. Unsupported bridge versions refuse. Existing Codex command behavior and old native records remain readable.

Pi locator-bearing binding facts MUST use a critical protocol revision that older readers refuse before dispatch; silently ignoring nativeLocator is prohibited. The proposed allocation is execution payloadVersion 4, carrying connection facts. Current readers support versions 1-3 and refuse other execution payload versions. Every fact that carries a locator, including nested binding copies, requires version 4; it cannot be written as an extra field under version 2. Closed locator decoding, equality, replay and old-reader refusal remain unimplemented and require review. Existing records are not rewritten or assigned guessed locators. Registration without a verified locator cannot make a record eligible for Pi headless continuation. The HCN package pin and captured recordings change deliberately only after the new operation is built and checked. Local source acceptance does not imply publication or installation.

## Implementation Notes

Implementation proceeds in reviewed vertical slices:

1. Extension capture and helper admission. Tests attach to real registration/host APIs with injected process facts; native controls prove TUI eligibility, non-TUI/subagent exclusion, wrong owner, replacement generation and teardown.
2. Publication plus explicit tool receipt/respond. Real records prove preserved artifact failure evidence, duplicate readback, wrong/cross-offer refusal and actual outcomes. No listener is enabled merely by file installation.
3. Bounded agent_end transport. Fake-clock tests prove selection/cancellation races and full-context retention. Native Pi proves 45-second expiry, Escape cancellation, complete offer delivery, explicit receipt and response, and no hidden second Pi session.
4. Durable locator and HCN strict lookup/launch. Tests prove critical-reader refusal, exact native header/folder matching, ambiguity, missing-ID refusal, and interpreter process identity. A real custom-directory session proves same ID and retained native context after process exit.
5. Integrate supported settings, recordings and the package pin; run all Lucid/HCN gates and scoped Muse review. Enable only the operation whose native evidence is complete. Other interface acceptance stays separate.

No automatic runtime activation is authorized by this draft. Existing RFC 26/27 acceptance gates still apply. Browser instructions for Pi refer to the extension tool operations and exact record, not the Codex-only shell listener command.

Alternatives: a Bash override was rejected because it replaces an unrelated tool and can discard another extension's behavior. Session environment alone was rejected as insufficient parent/generation evidence, despite Pi's documented per-command injection. A long-lived session broker was deferred because per-operation child helpers preserve the existing host ownership model without a new listener socket. HCN-wide session discovery was rejected because the caller already has an exact captured locator and HCN owns no cross-process registry.

## Open Questions

1. Direct-child callback authority remains proposed. A native TUI parent and its direct JSON child loaded the same synthetic session ID and reported different callback modes. That proves only this pair. SDK, RPC, nested TUI and root-parent provenance still need negative controls. A failing control blocks activation, not an automatic relaxation of the rule.
2. Execution payloadVersion 4 is the machine-made proposed critical allocation. Closed locator shape, path bounds, nested copies, HCN request grammar, header bounds, ambiguity rules and interpreter resolution still require a complete specification and review before implementation. No locator-bearing records are written by this draft.
3. agent_end supplied a live native AbortSignal in the 45-second and Escape probes, but it is a low-level run boundary, not agent_settled. Retry, compaction, queued follow-ups, exact signal ownership, supervision and readiness revocation still need a reviewed contract. The current Protocol Overview is a candidate, not a settled implementation instruction.
4. The native strict-open requirement is currently blocked by the demonstrated lookup/open race. Options are a supported native strict-open operation or retaining the unsupported lane. A second preflight, path copy, new session or silent identity substitution does not meet the accepted contract. Codex completion continues independently.

## Response to v1 review

The [Muse v1 review](28_pi-native-extension-bridge-and-strict-session-locators.review-v1.md) remains active. No Pi implementation is admitted by this revision.

- F1: proposed payloadVersion 4 is named above; full codec and reader behavior remains to be specified and reviewed.
- F2: the native race now blocks launch. Exact HCN grammar, bounds, directory rules and interpreter resolution remain unresolved; preflight cannot substitute for native strict open.
- F3: native AbortSignal observations are retained, while agent_end versus settled behavior is explicitly unresolved.
- F4: exact per-operation validator, transaction, idempotency and sendUserMessage mappings remain required.
- F5: direct-parent identity alone is not role or work authority. Callback role proof and generation/offer/epoch revalidation remain separate requirements needing a precise predicate.
- F6: the native same-ID JSON child control passed. Other provenance controls remain activation gates.
- F7: locator bounds and ambiguity semantics remain unresolved. Normal custom-directory resume is no longer described as strict-open proof.
- F8: helper supervision, byte-overrun refusal and replacement/reload cleanup ordering remain unresolved.

Native observations and the fault-injection recipe are retained under ignored artifacts/evidence/interactive-artifact-wayfinder/pi-negative-acceptance.md. They are test evidence, not a permanent claim that a future Pi release behaves the same way.

## References

Normative:

- [RFC 26](26_interactive-artifact-conversation-continuity.rfc.md) - publication, durable delivery, ownership, handoff and native acceptance.
- [RFC 27](27_native-approvals-during-headless-continuation.rfc.md) - native settings and approval preservation during continuation.
- [HCN ownership](../adr/0005-hcn-owns-harness-differences.md) - normalization and process supervision boundary.
- [Kernel locks](../adr/0003-kernel-locks-divide-append-authority-from-execution.md) - one append/executor locking model.

Informative:

- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) - current-session callbacks, run mode, cancellation and native messaging; the installed 0.85.1 documentation supplies the tested API shape.
- [Pi environment documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md) - per-command session injection and its optional disabling.
- [Pi session format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md) - native identity and session manager methods.
