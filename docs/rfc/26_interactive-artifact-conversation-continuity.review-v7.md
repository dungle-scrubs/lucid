# Review: RFC 26 v7 - Native publication before binding

What was reviewed: `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md`, version v7, status Draft. Scope was limited to the v7 amendment `Native publication before binding` (RFC lines 80-102). Version v6 stays accepted. No product choices outside the amendment were reopened.

Structural results, verbatim:

```
{"passed": true, "errors": [], "warnings": []}
```

Passed true, errors [], warnings []. Source: `publication-fence-rfc-v7-structure.json`.

The compiled reproduction `publication-failure-probe.json` confirms the bug the amendment targets:

- `publication.publication.status` is `published`, `publication.connection.reason` is `registration-missing`.
- `feedback` is `accepted`.
- `managedCandidates` is `["browser-probe-feedback"]`.
- `nativeSpawned` is `false`.

That is rung 4 evidence. The record is readable and feedback is saved, yet ordinary managed dispatch still selects it.

Current code pointers corroborate the gap (rung 2):

- `src/cli/artifact-publish.ts:58-195` creates or resolves the record, writes the artifact, then attempts binding. It records no durable native requirement and no durable connection failure. Failure is returned only.
- `src/store/managed-readiness.ts:29-43`: `managedCandidates` fences only on non-null `state.connection` and uncertain `attempt-ended`. An unbound record with no `connection` falls through to `eligibleExecutions`.
- `src/store/connection-view.ts:289-295`: unbound projects generic `setup-required` with `registration-missing`.
- `src/server/client/native-connection.tsx:38-39`: returns `null` when there is no `nativeSessionId`, so unbound setup has no visible recovery surface.
- `src/server/managed-launch.ts:46` consumes the same `managedCandidates`, so the reconciler can request a worker for the probe record.

The amendment direction is sound: opt in before artifact write, retain failure provenance, fence managed admission, keep ordinary managed records unchanged, keep no migration and no fresh-session fallback. The findings below are gaps in the amendment text, not rejections of that direction.

## Findings

### F1. New connection fact shapes are not defined anywhere

Section: `Native publication before binding`, RFC lines 84-89.

The amendment adds `publication-requested` and `publication-connection-failed` to the existing `execution` `payloadVersion: 2` envelope, plus a replay `nativePublication` state. The existing v2 contract at RFC lines 247-248 lists binding, listener, offer, reconnect, and launch payloads. It is not updated. The `ConnectionFact` union in `src/protocol/connection.ts:276-356` has no such kinds in this snapshot.

Missing wire definition:

- Exact field names for request action ID, failure action ID, reason, message, timestamp.
- Parser bounds are stated in prose (message at most 2,000 UTF-16 code units, reason nonempty control-free at most 128) but no parser location or refusal issue is named.
- Reducer transition: what state changes, what duplicate means, what conflict means.
- Line 86 says repeating the requirement is idempotent. Line 105 of the base document says conflicting repeats are refused. The amendment does not say whether a second requirement with a different action ID is a duplicate or a conflict.
- Line 87 says failure requires a preceding request and never grants authority. It does not say where that ordering is enforced: parser, reducer, or host transaction.

This is an actual unspecified design decision, not a requirement left for implementation. Implementation cannot proceed without the fact schema and transition table.

Rung: 2, code pointer plus textual gap.

### F2. Shared admission predicate is named but not specified

Section: amendment lines 89, 93; base Design 9 lines 249-252.

Line 89 says a shared predicate identifies records that require native admission, whether awaiting binding or already bound. Line 93 says shared checks repeat under host and append ordering. Line 101 lists acceptance at publication, replay, HTTP, host admission and dispatch, and browser.

The predicate itself has no name, signature, truth table, or owner module. Open points:

- For unbound-required records, it must fence `managedCandidates` in `src/store/managed-readiness.ts:29-43`, managed preparation candidate checks in `src/modes/managed-preparation.ts:143-203`, per-turn dispatch, `acquireExecutor` headless path in `src/store/conversation-host.ts:1318-1380`, runtime admission in `src/cli/runtime.ts:288-300`, and the launch reconciler in `src/server/managed-launch.ts:46`.
- For bound records, `managedCandidates` already returns `[]` when `state.connection` is non-null. The amendment does not say whether the new predicate replaces that check, supplements it, or returns true for bound records too.
- `nativeInputCandidates` in `src/store/managed-readiness.ts:67-91` already returns `[]` when there is no `state.connection`. The amendment should state explicitly that pre-binding feedback has no native candidate path either, so it stays held rather than lost.
- `fresh-authorized` and `retry-authorized` entries are eligible in `eligibleExecutions` at `src/store/managed-readiness.ts:104-128`. Line 93 prohibits ordinary candidates, legacy executors, new sources, ordinary attempts, and final dispatch. It does not name `fresh-authorized` or `retry-authorized` explicitly. A reader cannot tell whether an authorized retry from before the requirement is blocked.

This is an actual unspecified design decision for the predicate contract. The per-callsite wiring is a requirement left for implementation once the predicate exists.

Rung: 3, traced from probe through `managedCandidates`, preparation, `acquireExecutor`, and reconciler.

### F3. Candidate-selected-before-publication race has no transaction specified

Section: amendment lines 91, 93.

Line 91 orders requirement before artifact admission and registration lookup. Line 93 says shared checks repeat so a candidate selected before publication cannot bypass the constraint.

What is missing:

- Which transaction writes the requirement, and which locks it holds. Base rules at RFC lines 72-73 and 201-203 cover registration-scoped locks, append transactions, and registration-before-append order for binding. The requirement write is not placed in that order.
- How in-flight preparation is invalidated. `src/modes/managed-preparation.ts:143-203` snapshots candidates, captures dispatch with a stamp, rechecks candidates, then calls `writePreparedExecution`. `src/store/conversation-host.ts:1434-1458` routes bound records to `launch-intended` and unbound records to a staleness check. The amendment does not say whether the requirement bumps the stamp basis, the prerequisite hash, or the connection revision, nor which stale issue preparation must observe.
- Whether publication itself must hold the append lock across requirement plus artifact write, or whether two separate appends are allowed with a defined interleaving against concurrent preparation.

Without that, two implementations can both claim to repeat checks yet admit different interleavings. This is an actual unspecified design decision.

Rung: 3, traced through preparation and `writePreparedExecution`.

### F4. Already-started work boundary is ambiguous

Section: amendment lines 93, 99-100.

Line 93 says work whose native creation or delivery boundary already passed may settle through its existing owner and ordinary outcome path. The requirement neither kills the process nor fabricates cancellation, receipt, departure, or cleanup. Line 99 says a pre-requirement attempt past its execution boundary is not replayed by repair.

`Creation boundary`, `execution boundary`, and `delivery boundary` are not defined against existing durable states:

- `attempt-started` recorded.
- HCN invocation begun.
- `started` provenance recorded.
- Turn settled with `attempt-ended`.

The distinction matters. An `attempt-started` record with invocation not yet begun must be held, not dispatched. An invoked child must be allowed to settle without a second dispatch. `reconcileExecutionFact` and the existing uncertain-settlement path need an explicit statement that attempt count is frozen and no new attempt may start for a required record until binding.

This is an actual unspecified design decision. The settle-without-replay behavior is otherwise consistent with the high-priority ask that existing work may finish but not replay.

Rung: 2, code pointer to execution states plus textual gap.

### F5. Old-reader and unknown-kind refusal is underspecified for the new kinds

Section: amendment line 89; base Design 9 lines 259, 326.

Line 89 says readers that cannot understand either new fact MUST refuse the critical envelope without changing bytes or launching, as for other unsupported connection facts.

Gaps:

- The new facts are new `connection` kinds inside `payloadVersion: 2`, not a new payload version. Line 259 covers unknown connection versions with `unsupported-connection-payload`. It does not cover unknown connection kinds inside a known version. The amendment does not say whether an unknown kind bricks the fold, is carried and skipped, or is refused with a named issue.
- Current `src/store/log.ts:585-595` already throws `unsupported-connection-payload` for `payloadVersion !== 1` on the execution source in this snapshot. The RFC line 259 still quotes the older baseline wording `corrupt-log: Unsupported execution payload`. That is evidence and code drift in the review text, not in the product. The normative behavior needs one current citation: which store error, which HTTP or CLI surface, and proof of no truncation or launch.
- Line 259 retains the no-downgrade policy even after work settles. Combined with line 95 having no clear or convert action, an opted-in record permanently requires a new reader. That follows from preserving the fence, but the amendment should state the operational consequence once: backup, copy, or older-binary open of an opted-in record stays refused.

Refusal without mutation is a requirement left for implementation. The unknown-kind disposition and the corrected baseline citation are unspecified design decisions.

Rung: 2, pointer to `src/store/log.ts:585-595` and RFC line 259.

### F6. Projection and browser shape do not match the existing state enum

Section: amendment lines 97-98; base Design 8 lines 163-178 and Design 9 lines 253-257.

Line 97 adds `nativeConnectionRequired` derived only from durable requirement and binding facts, preserves the recorded failure reason for unbound records, distinguishes no-result as unfinished, keeps identity null, and offers generic setup plus exact-record retry guidance with no working retry button.

What does not line up:

- The `ConnectionStatus` state union in `src/protocol/connection-status.ts:7-22` and the projection table at RFC lines 163-178 have no held-for-native-publication state. If unbound-required reuses `setup-required`, the amendment must say so and explain how `nativeConnectionRequired` separates it from ordinary managed `setup-required`.
- Current `readConnection` in `src/store/connection-view.ts:328-349` has no `nativeConnectionRequired` field. The amendment names the concept but gives no field placement: top-level projection field, browser-only derivation, or CLI `--json` field.
- The action vocabulary at RFC lines 253-255 has `setup-instructions` but no retry-publication action. Line 97 says guidance, not a working retry button. The exact command or instruction text is a requirement left for implementation. The absence of a new action ID versus reuse of `setup-instructions` is a design decision and should be stated.
- `src/server/client/native-connection.tsx:38-39` hides everything without `nativeSessionId`. The amendment requires showing unbound setup while leaving ordinary managed records alone. That component change is a requirement left for implementation, but its acceptance condition needs the projection field first.

This is mixed: the UI work is implementation, the projection field and state mapping are unspecified design decisions.

Rung: 2, pointers to projection type, `connection-view.ts`, and `native-connection.tsx`.

### F7. Failure-write-fails path has no result contract

Section: amendment line 91.

If recording the connection failure fails, the requirement still holds feedback and the command reports that the connection result could not be saved rather than claiming durable diagnostics.

Missing:

- Publication result shape in that case: `publication.status` stays `published`, but what goes in the `connection` field when nothing durable was recorded.
- Error code, HTTP status, CLI exit behavior, and whether retry uses the same failure action ID or a new one.
- Interaction with line 89 replay retaining the most recent failure: a failed failure-write leaves no failure, so replay must distinguish no-result from recorded failure. Line 97 anticipates this with the did-not-finish message, but does not tie it to this path explicitly.

This is an actual unspecified design decision on the result contract. The durable hold itself is sound.

Rung: 1, assertion from text; no code path exists yet.

### F8. Retry identity and artifact conflict are incomplete

Section: amendment lines 91, 95.

Line 91 says retry uses the original creation key or conversation ID and the same artifact identity, version, and bytes when those were already saved. Line 95 says publication into an already bound record cannot overwrite binding or relax admission, and a later failed registration stays history.

Unresolved:

- Retry with different bytes or a different version for the same artifact identity: refused with which issue, or accepted as a new version under the same held requirement. Current `src/cli/artifact-publish.ts:146-155` already has same-bytes idempotent versus `artifact-version-exists` refusal logic. The amendment should state how the requirement interacts with it.
- Second publication attempt with a different registration reference while unbound: whether it replaces the retained most-recent failure, appends history, or is refused. Line 89 says replay retains the most recent failure, which implies replacement, while line 95 says a later failure remains history after binding. The unbound-versus-bound distinction should be explicit.
- Whether the requirement action ID is derived from the creation key, the conversation ID, or a fresh UUID per attempt. Idempotent repeat handling depends on it.

This is an actual unspecified design decision.

Rung: 2, pointer to `artifact-publish.ts:146-168` plus textual gap.

### F9. Held draft and refused-write states need explicit durable meaning

Section: amendment line 91.

Once the requirement is durable, a crash before artifact write leaves a held draft, and a crash after artifact write before binding leaves a held readable artifact. A refused artifact write does not erase the requirement, existing version, or feedback.

Questions left open:

- A held draft with a requirement but no artifact version: what `readArtifact` returns, what the browser message says, and whether the did-not-finish wording at line 97 covers it.
- A refused artifact write caused by invalid content: the requirement persists with no new artifact. Retry with corrected bytes is not addressed; see F8.
- A record with a requirement but an empty executions map is already fenced in practice because `eligibleExecutions` returns nothing. The amendment should state that the fence does not depend on executions existing, so the draft state is explicitly held rather than vacuously empty.

The crash ordering itself is sound and matches the high-priority ask of no lost accepted input. The durable shape of the draft is unspecified.

Rung: 2.

### F10. Binding-race lock order for the requirement write is missing

Section: amendment lines 76, 91, 93, 95.

Line 76 serializes binding under the record append transaction. Lines 91-95 add requirement writes, failure writes, binding guards, and no-overwrite rules for already-bound records.

The amendment does not say:

- Whether requirement and failure writes use `writeConnection`, a new host method, or raw appends.
- Whether they acquire the registration lock, the append lock, or both, and in which order relative to RFC lines 201-203.
- How a concurrent binding and a concurrent requirement write serialize. The no-overwrite rule for bound records needs an atomic check: if binding lands first, the requirement write must join rather than conflict; if requirement lands first, binding must still pass the unsettled-work, attachment, owner, folder, and native-history guards.

This is an actual unspecified design decision with crash, identity, and authority consequences.

Rung: 2, pointer to lock-order rules and `conversation-host.ts` host methods.

## Cleared

Checked and found sound, within the amendment scope:

- No fresh-session fallback: line 93 withholds ordinary candidates, executors, sources, attempts, and dispatch, and freezes delivery cursors. Retired fallback stays out of scope at RFC line 25.
- No optimistic ownership: line 93 retains unsettled-work, attachment, owner, folder, and native-history guards before binding. Lines 68-70 retain verified ancestry, generation checks, ambiguity refusal, and unknown desktop ownership.
- No lost accepted input: requirement holds rather than drops; already-accepted feedback stays saved; cursors do not advance on withholding; failure-write failure still holds.
- No automatic native identity migration: lines 95, 99-100 prohibit clear, convert, retrospective classification, and inference from artifact text, folder, or preference.
- Failure provenance retained: failure fact keeps action ID, bounded reason, message, and host timestamp; later failures stay history after binding.
- Ordinary managed preservation: only an explicit new publication attempt opts in; prior records keep prior behavior.
- Browser does not classify by preference: line 97 says saved preference never selects the unbound state, and identity stays null until supported evidence establishes it.
- Deterministic structure check passed with no errors or warnings.

## Not reviewed

- Full v6 implementation correctness beyond the amendment touch points.
- Native acceptance lanes for Codex CLI, Codex desktop, Claude CLI, Pi CLI, and Muse CLI. Open Questions 1-2 explicitly leave them pending.
- HCN `interactive` operation internals beyond the amendment reference.
- Exact UI copy, layout, breakpoints, themes, and live-region behavior for the new unbound setup surface.
- Performance, log growth, or action-ID storage bounds for repeated failures.
- Reads outside the snapshot, native transcripts, credentials, environment, history, shell, network, or agents, per the task constraint. All findings above come from the RFC text, `publication-failure-probe.json`, and direct snapshot reads.
