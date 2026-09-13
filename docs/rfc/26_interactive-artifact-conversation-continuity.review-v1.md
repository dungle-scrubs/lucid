# Review: RFC-26 Interactive artifact conversation continuity, v1

## What was reviewed

- Path: `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md`
- Version: `v1` (frontmatter `version: v1`), status `Review`, type `feature`, dated 2026-09-11.
- Scope note, per instruction: this review preserves the accepted five-interface scope (Codex CLI, Codex desktop, Claude CLI, Pi CLI, Muse CLI), the finish-current-headless-turn policy, and the required Claude/Pi Lucid reconnect path. It proposes no global coordinator and no product redesign.

Assumption proceeded under: the supplied validator result is quoted verbatim below because this session is read-only and cannot execute the validator.

## Structural results

Supplied validation (author ran `validate-structure.ts` on this exact v1):

```json
{"passed":true,"errors":[],"warnings":[]}
```

Not independently re-executed in this session (read-only tool scope). No structural objection re-derived by hand.

## Findings

### F1 (blocker): Correlated receipt path for the Stop-hook interfaces is unspecified

- Section: Design 4 (RFC lines 93-95) crossed with Design 5 (lines 101-103) and Open Question 2 (lines 201-202).
- What is wrong: Design 4 requires receipt to identify offered input, epoch, participation, and integration-captured native identity, with matching repeats idempotent and stale/mismatched epochs refused. Design 5 assigns Codex CLI and Muse CLI to the synchronous Stop continuation path. Nothing states what native payload carries the Lucid input ID / epoch / participation back through a Stop hook, or which callback is the receipt boundary as distinct from the dispatch transport. Native listener evidence establishes that a Stop continuation can inject a marker and continue the same session (rung 2, `interactive-artifact-session-listener.md` lines 12-23, 34), but explicitly warns that hook exit success is not receipt and that Muse vs Codex framing differs. Resolution-258 (lines 26-28) leaves hook-carried structured receipt vs extension acceptance facts as future work per interface.
- Consequence: the `accepted -> dispatch-begun -> received` transition is unimplementable for the two interfaces that carry the most delivery weight. Implementers will either treat hook return as receipt (which Design 4 forbids) or invent an out-of-band acknowledgement.
- Proposed correction: add a per-interface receipt table (Stop payload field, extension event, or explicit `lucid connection receipt` invocation point) naming the exact fields that carry input ID, epoch, and participation, and state which side (hook adapter vs integration daemon) constructs the `receipt` fact. Until that table exists, mark the Codex/Muse receipt lane as acceptance-gated alongside Open Q2 rather than specified.
- Evidence rung: rung 2, pointed at RFC text and the cited native-evidence limits. No new execution was possible in this read-only session.

### F2 (blocker): "Proof of no child" and "proved non-delivery" have no named evidence

- Section: Design 6 (lines 113-117), Design 7 (lines 128-130), State Machine (lines 158-160).
- What is wrong: several safety transitions hinge on proof: `launch-intended -> pre-start-refused` requires proof of no child; requester-death withdrawal requires proof native creation never started; retry-after-refusal reuses the same input with a new attempt ID while uncertain started attempts are never auto-replayed. The RFC never names which HCN/harness result constitutes that proof. Current code distinguishes explicit refusal (evidence of non-delivery) from closed-pipe/unknown disposition (not evidence) (rung 2, `src/harness/runner.ts:105-110` `SendResult`, `docs/drivers.md:383-388`). The RFC does not bind its proof terms to those existing evidence values or to the new HCN interactive-launch operation's result taxonomy.
- Consequence: two implementers will pick different proof thresholds. A weak reading replays uncertain work or admits a second owner; a strict reading deadlocks on every ambiguous launch.
- Proposed correction: define the closed set of launch-operation outcomes that count as proved pre-start refusal (e.g. named HCN refusal codes), and state that every other outcome (timeout, transport loss, unknown child state) leaves the attempt `launch-uncertain` and held. Tie the existing `reconcileExecution` uncertain rule (`docs/drivers.md:261-266`) to the new launch facts explicitly.
- Evidence rung: rung 2, RFC text plus cited source lines. Proof-threshold choice itself is rung 1.

### F3 (blocker): Registration provenance, ID properties, and lock ordering are undefined

- Section: Design 2 (lines 65-69) crossed with Security Considerations (lines 170-172).
- What is wrong: registration must contain PID, start identity, executable, and "provenance from the supported lifecycle callback," with interface and harness required to agree. Missing: (a) which callback per interface supplies provenance; (b) format/entropy/bounds of the generated registration ID and opaque reference (only "bounded lengths" is stated); (c) ordering between the registration-scoped kernel lock and the record append lock when publication records the binding under the append transaction. Current secret discipline is per-record (`src/store/store.ts:53-71`, `src/store/conversation-host.ts:188-196`, rung 2); the new private registrations directory under the Lucid root introduces a second authority with no stated auth rule beyond "integration-captured."
- Consequence: a stale or spoofed registration can produce ambiguous/conflicting bindings whose refusal path (which reason family, which retry) is not tied to the Error Handling list. The "changed registration cannot overwrite a conflicting binding" rule (line 73) has no named conflict-resolution operation.
- Proposed correction: add a registration table (interface, harness value, lifecycle callback, session-ID format, folder canonicalization), ID entropy and reference format, the two-lock acquisition order, and the exact refusal (reason family + action IDs) for ambiguous and conflicting bindings.
- Evidence rung: rung 2 for the missing-table claim (RFC lines plus cited store files searched; no registration code exists under `src/`, which is itself a search result worth reporting). Severity judgment is rung 1.

### F4 (blocker): HCN interactive-launch operation is normatively required but entirely deferred

- Section: Design 7 (lines 121-127) and Open Question 1 (lines 201-202), crossed with `src/harness/runner.ts:176-207`.
- What is wrong: Design 7 norms depend on "HCN starts the native interactive runtime with the exact saved session and folder, returning child provenance." The current `HarnessRunner` seam exposes `openSession`, `streamTurn`, `inspect`, `capabilities`, `countContext` only (rung 2, `runner.ts:176-207`); there is no interactive-launch operation, no argument shape, no provenance shape, no failure taxonomy. Implementation Plan step 5 acknowledges the operation must be specified/added, and Open Q1 correctly flags it as acceptance work. The problem is structural: Design 7 and the State Machine (`child-confirmed`, `admitted`) read as specified behavior while their transport does not exist.
- Consequence: the protected-reconnect path cannot be implemented or tested from this RFC alone; reviewers may approve behavior whose seam is still to be invented, including native argv handling that ADR-0005 forbids mirroring locally.
- Proposed correction: keep Open Q1 as the gate, but demote Design 7's launch sentences that assume the operation to conditional language ("once the HCN operation in Open Q1 exists...") and require the operation's name, args, provenance fields, and refusal codes as part of closing Q1. Do not weaken the five-interface scope or drop desktop while doing so.
- Evidence rung: rung 2 (RFC lines plus seam file lines).

### F5 (blocker): The reconnect admission fence is not wired to any named seam

- Section: Design 7 (lines 123-126) crossed with `src/store/managed-readiness.ts:28-68` and `src/server/managed-launch.ts:14-53`.
- What is wrong: the RFC states the reconnect reservation prevents a managed worker from winning the transition gap and that the active executor "observes requested before scheduling another input." No section says which function owns that observation. The existing readiness oracle (`managedCandidates`) knows `requested`, `attempt-started`, `held`, and authorizations, returns `[]` on any uncertain attempt, and has no reconnect-request concept (rung 2, `managed-readiness.ts:28-68`). The launch reconciler keys off terminal presence and `managedCandidates` (rung 2, `managed-launch.ts:26-48`). The RFC never states whether a reconnect request is an `ExecutionFact` extension or a member of the new control-log family, so the fence the safety argument rests on has no attachment point.
- Consequence: as specified, a managed worker using the current seams will ignore the reservation. The transition-gap protection is a claim without a mechanism.
- Proposed correction: name the seam (extend `managedCandidates` / reconciler / dispatch-boundary check), define the reconnect-request record shape in the same parser as the control facts, and add the deterministic case "reconnect requested while worker is selecting candidates" to the highest-priority list (line 195 already lists reconnect-versus-launch; extend it to candidate selection).
- Evidence rung: rung 2.

### F6 (spec gap, near-blocker): Interface/harness agreement and identity provenance table missing

- Section: Design 2 (line 65: "Interface and harness MUST agree") and Design 5 (lines 101-107).
- What is wrong: interfaces are `codex-cli`, `codex-desktop`, `claude-cli`, `pi-cli`, `muse-cli`; harnesses per CONTEXT.md are `claude`, `codex`, `pi`, `muse` (rung 2, `CONTEXT.md:64-70`). The agreement mapping (both `codex-cli` and `codex-desktop` map to `codex`, yet CLI evidence MUST NOT satisfy desktop) is never tabulated. Likewise "exact native working folder" has no canonicalization rule, and "native process identity (PID, start identity, executable)" has no per-interface capture rule. Open Q2 covers wait bounds and receipt callbacks but not identity/folder provenance.
- Consequence: "exact native identity and folder" (Design 6, line 111) is unverifiable as written; admission checks will differ per implementer.
- Proposed correction: add the five-row table (interface, harness, lifecycle callback, session-ID provenance, folder canonicalization, owner-corroboration method) and extend Open Q2 or add Q3 to gate each row on isolated live checks. This is acceptance work, not a scope cut.
- Evidence rung: rung 2 for the mapping gap; rung 1 for the predicted divergence.

### F7 (spec gap): Connection projection schema and reason-to-action mapping undefined

- Section: Design 8 (lines 135-152) and Error Handling (lines 164-166).
- What is wrong: the status table gives prose labels, messages, and available actions, and Error Handling lists 14 reason families, but there is no typed projection schema (field names, reason enum wire values, action-ID vocabulary), no mapping from each reason family to HTTP/E-code or to supported action IDs, and no freshness rule for "fresh owner checks" on the browser read path (timeout, caching, failure behavior). `lucid connection status` is specified as read-only (line 59) yet its projection depends on live process-table probes.
- Consequence: browser and CLI will independently infer ownership/action availability, which is exactly what line 135 forbids. Prototype behavior (which renders these states from simulated facts) cannot be conformance-tested against prose.
- Proposed correction: define the projection type, the reason-to-action-ID map (only supported actions, per line 164), and probe bounds/failure semantics for read-path owner checks.
- Evidence rung: rung 1 (specification absence; confirmed by whole-document read).

### F8 (spec gap): Migration, old-reader, and downgrade behavior undefined

- Section: Implementation Plan (lines 197-198).
- What is wrong: "New connection facts require the new reader; replay MUST fail clearly on unsupported control records rather than drop the admission fence" names no error, no read-path behavior for an old binary opening a new record, and no checkable downgrade gate for "no in-flight offers, launches, or reconnect reservations." Existing records "keep their current behavior" is stated, but the forward-compatibility envelope (new control records carry their own envelope source, as context entries do per `docs/drivers.md:255-256`?) is not.
- Consequence: mixed-version handling and downgrade safety are left to implementer choice at the exact point where a wrong choice drops the admission fence.
- Proposed correction: name the refusal/error for unsupported control records, state old-reader behavior (refuse record open with named error vs skip), and define the downgrade precondition as a query over named fact kinds.
- Evidence rung: rung 1.

### F9 (minor): Two similarly named reconnect commands invite misuse

- Section: Design 1 (lines 57-58): `lucid connection reconnect <conversationId>` vs `lucid reconnect <conversationId>`.
- What is wrong: the names differ by one path segment but denote opposite ends of the flow (in-session resume-listening vs terminal entry point that reserves return before launching). Help text is required to explain the difference (line 121), but the CLI contract itself carries the confusion, including in transcripts and user instructions.
- Consequence: users and skills will invoke the wrong one; Claude/Pi protected-workflow compliance (which depends on using the right entry point) will erode.
- Proposed correction: rename one (e.g. `lucid connection resume-listen` for the in-session operation) or keep both spellings with a mutual-hint refusal. This is a naming suggestion, not a scope change.
- Evidence rung: rung 1.

### F10 (minor): Undefined "managed browser envelopes" term

- Section: Design 4 (line 89) vs Terminology (lines 29-37).
- What is wrong: "Managed browser envelopes and ordinary inputs share this path" uses a term defined nowhere in Terminology and not matching the existing "managed-input-v1 / managed: true" vocabulary (`docs/skill-chat-substrate.md:198-212`, rung 2). A whole-document search for a definition finds none (search result reported, not an invention).
- Consequence: readers cannot tell whether "envelope" means the managed-input frame, the comparison/input batch, or a new wrapper, which matters for the "MUST NOT be ignored merely because an execution entry exists" rule crossed with `readQueuedInputs` filtering out inputs that have execution entries (rung 2, `src/modes/interactive-host.ts:115-124`).
- Proposed correction: define the term in Terminology or replace it with the existing `managed: true` input language.
- Evidence rung: rung 2 for the missing-definition and drift-citation claims.

## Cleared

Checked and found sound (so the next reviewer need not repeat):

- Five-interface scope is held without silent waiver: unsupported/unavailable lanes return explicit disconnected results and no lane ships as supported without verification (lines 105-107, 197; resolution-257 acceptance). Rung 2.
- Finish-current-headless-turn plus cleanup-before-admission ordering, including question/failure outcomes reaching their normal result and the waiter holding no executor lease (lines 123-125, 129; resolution-259 handoff rules). Rung 2.
- Claude/Pi Lucid reconnect path as a required workflow with direct-resume-bypass detection and conflict hold (lines 121, 131; native resume-admission probes showing Pi/Claude concurrent-use vs Codex/Muse conflict, rung 2).
- Saved-vs-receipt-vs-outcome separation, hook-write-is-not-receipt, no truncation or synthetic chunk inputs, stale/mismatched receipt refusal (lines 89-97; consistent with `docs/drivers.md:86-91` and native-evidence framing warning). Rung 2.
- Unknown-owner holds work with no Assume-closed action, no automatic fresh-session fallback, expiry revokes readiness but never records departure (lines 83, 111, 150, 164-166). Rung 2.
- No global coordinator or second queue: record/append-ordering/executor-lock ownership retained, HCN owns invocation behind the seam (lines 61, 125, 179; ADR-0003, ADR-0005). Rung 2.
- Publication survives failed binding with separated `publication`/`connection` results; crash-after-publication-before-binding leaves a readable artifact (lines 71-73). Mechanism details belong to F3/F8, but the policy direction matches the accepted disconnected-publication decision. Rung 2.
- Prototype fidelity on the reviewed points: simulated reducer enforces saved/sending/received/answered/uncertain/cancelled separation, pre-creation transcript notice, cleanup gating, and Claude/Pi-only bypass conflict (prototype lines 32-74, 85-91), consistent with the RFC's state labels. Prototype is explicitly simulated (line 29) and therefore corroboration only. Rung 2.

## What was not reviewed

- Validator execution: read-only session; supplied `{"passed":true,"errors":[],"warnings":[]}` quoted without re-execution.
- Source structural graph for this worktree: the index covers `main` at Users-kevin-dev-lucid, not this worktree; all source behavior claims above rest on direct file reads cited per finding, and reach beyond the read functions is qualified as untraced.
- Prototype interaction behavior beyond code read (no browser run); native transcript JSON/NDJSON fixtures beyond the two research reports; environment/config credentials and unrelated native transcripts (not read).
- Full test-suite or deterministic-oracle runs; line-level audit of files outside the six named sources except where cited (`runner.ts`, `interactive-host.ts`, `managed-readiness.ts`, `runtime.ts`, `managed-launch.ts`, `execution.ts`, plus `drivers.md`, `skill-chat-substrate.md`, ADRs, resolutions).
