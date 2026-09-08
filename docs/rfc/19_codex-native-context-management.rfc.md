---
number: 19
title: "Codex native context management"
type: feature
status: Accepted
author: Kevin
date: 2026-09-08
version: 2
---

# RFC-19: Codex native context management

## Abstract

Lucid blocks all Codex prompts because it requires preflight context accounting that Codex does not expose. Verified Codex headless turns will delegate context management to Codex. Lucid retains complete recorded context, executable verification, native session continuity, and explicit failure recovery. Claude keeps its existing preflight and summary path.

## Introduction

The user creates documents through a conversation and repeatedly submits prompts that Lucid holds before execution. This serves Lucid's existing document and conversation purpose and holds product scope: an already offered harness becomes usable. It adds no mode or settings control. It does not change Claude, pi, Muse, interactive attachment, or persistent-session accounting.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

Native management delegates compaction of the growing native thread. Codex may reject an oversized staged incoming request before compaction; this is not a guarantee that every submitted context fits. Preflight means Lucid obtains a native count before starting a task. An offered context copy is the complete, addressable record projection prepared by Lucid.

## Motivation

Codex 0.153.4 passes hcn's capability, native resume, kill/resume, and escalation checks. Its app-server generated protocol and exact release source expose historical token usage, but no count of a staged pending request. Repeating a prompt cannot repair this mismatch. Token estimates invented in Lucid would not establish equivalent accounting.

## Design

HCN MUST declare verified native management as descriptor data, exposed by `inspect --json`: `nativeContextManagement: { kind: "auto-compaction", modes: ["headless-turn"] }`. The Codex descriptor at verified version 0.153.4 declares it. Other descriptors and their dumps use null. Context inspection remains unavailable on Codex and MUST NOT fabricate counts.

Lucid's harness boundary MUST validate that declaration and expose native-management eligibility for headless turns. Eligibility requires headless-turn membership and only known modes (headless-turn, headless-session, interactive). Additional known modes do not remove headless-turn support. Unknown kinds or modes, missing declarations, and older hcn builds MUST retain preflight behavior. The mode layer MUST NOT keep a harness-name or model-capacity table.

Managed preparation MUST first capture the existing canonical context, validate driver settings, resolve native continuity, and inspect the selected executable. Exact executable/version agreement remains required. Only a verified headless-turn route with the declaration MAY use native management. That path MUST render the complete captured context without local summarization or truncation, retain the offered copy, and use the existing prepared-execution fence before recording an attempt. Its preparation result MUST explicitly represent accounting as null, never a successful measured count.

Native resume MUST reuse the existing confirmed session ID. Cross-harness or fresh continuation MUST keep the existing offered-context reconstruction and acknowledgment rules. Native context failures MUST flow through the current hcn failure events and durable execution outcomes. No context failure automatically restarts a turn, creates a new session, or silently drops history.

Claude and every route without the declaration MUST retain the current preflight checks and bounded summary behavior. No count failure, version mismatch, cancellation, malformed declaration, or selected-mode mismatch authorizes the native path by itself. HCN validates and forwards the selected model. Observed model agreement is unverified on the native route because no native preflight observation exists; this route MUST NOT claim that agreement was measured.

## State Machine

Requested or explicitly rechecked held input -> captured context -> verified route -> native management or preflight -> fenced attempt -> running -> completed, failed, or uncertain under existing execution rules. A stale capture or cancellation before dispatch remains held without task effects. A native context failure after dispatch remains recoverable using the existing outcome policy. No new durable execution state or migration is needed.

## Error Handling

E-HUB-03 still holds unverified executables, unavailable selected modes, and unsupported preflight routes. E-HUB-06 still covers stale context and preparation errors. Native runtime failures preserve the accepted input and use the existing explicit recovery actions. Old E-HUB-03 records can be reevaluated by saving their unchanged settings; the settings revision advances and the existing prerequisite logic wakes them. Rollout MUST use that supported action for the user's held prompts, preserving their order and contents. This rollout covers E-HUB-03 only; E-HUB-06 needs its explicit Retry action. A repeated oversized runtime submission remains failed-after-start with the native error visible in the transcript. Continue fresh requires acknowledgment and does not promise to fix capacity; changing settings or current document content first can be necessary. Lucid MUST NOT loop retries or silently shrink the captured context.

## Security Considerations

All harness execution remains through hcn. Tool grants, permissions, working folder, and attachment ownership remain unchanged. Native management cannot authorize a model call during read-only inspection. Complete offered context is preserved under the existing private record rules. No credentials or native hidden state are copied between harnesses. Native handling may reject an oversized first request; Lucid reports that failure without truncating the user's data.

## Alternatives Considered

Keep Codex blocked: contradicts the user's repeated request to make the selected harness work. Substitute a local character/token estimate: presents unsupported precision and duplicates harness policy. Switch to Claude: changes the user's selected harness and was rejected. Add a permissive global bypass: widens unrelated routes and can hide genuine accounting failures.

## Implementation Plan

One local ticket spans the hcn declaration, Lucid decoding and preparation selection, native failure regressions, and live conversation verification. Run hcn's dual-runtime gate and skill audit, plus Lucid's full check and compiled build. Verify fresh dispatch, native resume, rejection preservation, strict fallback for malformed declarations, and unchanged preflight behavior. Run one live Codex process at a time. The local server consumes the verified hcn checkout until the package release is integrated. When publishing this capability, update the Lucid dependency pin, HCN_MIN_VERSION, and captured fixtures together to that released version; do not claim an unreleased checkout is the pinned package.

## Open Questions

None blocking implementation. Machine-made implementation decision under the user's repeated request to fix Codex: delegate context management on the verified native route. No affirmative answer to the earlier policy recommendation is claimed.

## References

- `docs/drivers.md`: current context and managed execution contracts, amended by this RFC for declared native-management routes.
- `src/modes/managed-preparation.ts` and `src/modes/context-preparation.ts`.
- HCN `src/knowledge/codex.ts`, verified version 0.153.4, commit c4dad85 and its captured evidence.
- https://github.com/openai/codex/tree/rust-v0.153.4/codex-rs/core/src/session

## Review responses

Reviewed by opus-5@claude against v1.

- R1: Narrowed the guarantee to native thread growth; a staged request can fail before compaction.
- R2: Specified the stable failed state and explicit acknowledgment. Fresh recovery can fail again and is not advertised as capacity repair. No automatic retries are added.
- R3: Selected model validation remains; observed model agreement is explicitly unverified.
- R4: Decoder uses membership plus known-mode validation. Added a widened known-mode regression.
- R5: Distinguished E-HUB-03 settings reevaluation from E-HUB-06 explicit Retry.
- R6: Replaced contradictory driver documentation and distinguished counted versus native preparation.
- R7: Recorded the coordinated release pin, version floor, and fixture update. Current local use names the checkout explicitly.
- R8: Runtime regression proves failed-after-start, preserved input, acknowledgment-required recovery, and no automatic second process.
- R9: Matched captured-context terminology, preserving confirmed native coverage on resume.

Implementation detail: descriptor fields are required and nullable, matching the existing hcn key-coverage invariant. The public absent/unknown behavior stays unchanged.
