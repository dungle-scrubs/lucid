# Review: RFC 26 v8 - Native publication before binding

What was reviewed: `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md`, version v8, status Draft. Scope is the subsection `Native publication before binding` (RFC lines 80-112). Version v6 remains accepted. No product choices outside the amendment were reopened.

Prior review `docs/rfc/26_interactive-artifact-conversation-continuity.review-v7.md` (F1-F10) was read in full. Each finding below states whether its v7 item is resolved.

Structural results, verbatim:

```
{"passed": true, "errors": [], "warnings": []}
```

Source: `publication-fence-rfc-v8-structure.json`. Reported as passed true, errors [], warnings []. Not re-derived.

The compiled reproduction `publication-failure-probe.json` still confirms the target bug (rung 4):

- `publication.publication.status` is `published`, `publication.connection.reason` is `registration-missing`.
- `feedback` is `accepted`.
- `managedCandidates` is `["browser-probe-feedback"]`.
- `nativeSpawned` is `false`.

The record is readable and feedback is saved, yet ordinary managed dispatch still selects it. No native launch ran. The v8 amendment must fix that selection, retain failure provenance, and let the browser show unbound setup without classifying ordinary managed records by saved preference.

## Findings

### V8-1. Legacy delivery capture can become stuck with no operator reset

Section: v8 F4 paragraph, RFC line 107. Evidence rung 3 (traced from spec text through ledger code).

The conservative direction is sound: detach, epoch change, or process exit never resets captured evidence; receipt alone does not prove a response finished; recording the requirement creates no response and settles no input. That answers the "cleared without proof" half: nothing in F4 clears on detach, epoch change, exit, or receipt.

The stuck half is not resolved. F4 states:

- `legacyDelivery` captures epoch, in-flight count, and outstanding inputs outside the managed ledger whose `redeliver` is false and whose applied receipt is absent.
- A correlated applied disposition removes its input from `uncertainInputs` and increments the captured in-flight count.
- Unique terminal events in the same epoch retire the captured in-flight count using the existing InputLedger turn-end rule.
- Unconfirmed receipt or a nonzero captured in-flight count blocks binding and later dispatch.
- No assume-complete or reset control is introduced.

Combined with the actual ledger, this blocks forever in two reachable cases:

1. Epoch moves before the terminal arrives. Only same-epoch terminals retire, and epoch change never resets. A captured in-flight count from the old epoch then has no defined retirement path in the new epoch.
2. An input in `uncertainInputs` never receives its applied disposition (send issued, disposition lost). Terminal events retire only the in-flight count, not `uncertainInputs`. With no reset control, that input blocks binding forever.

Related ambiguity: the ledger retires only on `done` (`src/protocol/ledgers/input.ts:44-50,74-80`), and explicitly does not retire on session-terminal `error` with `terminal: true`. F4 says "unique terminal events" without naming `done`. If it means all terminals, it contradicts the ledger. If it means `done` only, an error-terminal turn leaves the captured count nonzero and stuck. The duplicate-applied case is also ambiguous: the live gauge treats a redelivered applied disposition as idempotent (one rise per id), but F4's "existing correlated applied disposition ... increments the captured in-flight count" does not say duplicates are excluded, which risks over-counting into the same stuck state. The ledger reset rule (`src/protocol/ledgers/input.ts:25-28`: attach and detach reset the live gauge to zero) is correctly not applied to the captured evidence, but F4 needs the complementary liveness rule it currently lacks.

This is an actual unspecified design decision, not a requirement left for implementation. The hold itself is correct. The missing piece is how a stuck capture is retired or escalated without fabricating delivery, receipt, or cleanup. It bears directly on the high-priority asks that existing work may finish but not replay, and that tracking must neither clear without proof nor stick incorrectly.

### V8-2. Old-reader refusal code name contradicts the cited code and the quoted probe

Section: v8 F5 paragraph, RFC line 108; base Design 9 line 270. Evidence rung 2 (code pointer) with rung 4 probe text.

V8 line 108 says the durable fold "raises `corrupt-log` with the `invalid-connection` refusal". The current fold path is:

- `src/protocol/connection.ts:892-894`: unknown kind returns `invalid-connection` refusal from `reduceConnection`.
- `src/store/log.ts:866-879`: a refused non-input entry throws `StoreError("fold-refused", "log entry at byte ... refused on fold (...)" )`.

The v8 paragraph then quotes the probe as `log entry at byte 0 refused on fold (invalid-connection)`, which matches `fold-refused`, not `corrupt-log`. The behavior (refuse without changing bytes or launching) is sound and the probe confirms it, but the code name in the normative sentence is wrong.

The same drift affects line 270, which still says baseline readers refuse `payloadVersion: 2` as `corrupt-log: Unsupported execution payload`, while `src/store/log.ts:590-594` throws `unsupported-connection-payload` for unknown execution payload versions. V8 line 108 correctly states unknown payload versions retain `unsupported-connection-payload`, so line 108 and line 270 now contradict each other.

This is spec and code drift on the error code, not on safety. The refusal without mutation or launch is a requirement left for implementation and is sound. The code name and the line 270 baseline citation are unspecified/incorrect and should name `fold-refused` with issue `invalid-connection` for unknown kinds inside version 2, and `unsupported-connection-payload` for unknown versions, with the existing store-failure to HTTP/CLI mapping stated once.

### V8-3. Unbound projection precedence and new reason families are incomplete

Section: v8 F6/F9 paragraph, RFC line 109; Error Handling, RFC line 304. Evidence rung 1 (assertion from text).

F6/F9 otherwise resolves v7-F6 and v7-F9: unbound required records reuse `setup-required` with `nativeConnectionRequired` true, last failure shown as last attempt, no-result uses `publication-connection-incomplete`, only `setup-instructions`, no retry-publication action or mutation endpoint, native ID and interface null, ordinary unbound records keep the boolean false, held drafts use the existing empty catalog and missing-version read, corrected content may fill an empty draft with normal new-version rules and same-version changed bytes still refused. That is coherent.

Two gaps remain:

1. Precedence. Line 109 says uncertain legacy receipt takes precedence as `delivery-uncertain`, and a nonzero captured in-flight count "instead" uses `outcome-unknown`. When both hold (nonempty `uncertainInputs` and nonzero in-flight), the two sentences order opposite outcomes. State the total order.
2. Reason vocabulary. `publication-connection-incomplete` (F6) and `connection-result-unrecorded` (F7) do not appear in the required reason families at line 304. Either extend that list or state explicitly that the amendment extends it. `connection-not-admitted` is used as a reducer issue; keep it distinct from the projection reason families when doing so.

These are actual unspecified design decisions on the projection contract. The UI work itself (showing unbound setup while leaving ordinary managed records alone) is a requirement left for implementation once the field and precedence exist.

### V8-4. Requirement and binding commute is overstated

Section: v8 F1 paragraph, RFC line 105. Evidence rung 1.

"Requirement and binding appends commute: either order retains both facts and runs the existing binding guards" is too strong. If binding guards fail (unsettled work, attachment, owner, folder, native history, or the new F4 legacy block), the binding fact is refused, not retained. The requirement is retained; binding is admitted only if guards pass. The intended behavior (requirement write joins rather than conflicts after binding; later failures stay history and cannot mutate a binding) is sound, but the sentence should say exactly that instead of promising both facts retained in either order.

This is a wording defect in an otherwise resolved design decision. Implementation must enforce the atomic check under the append lock; no file path or function name is needed in the RFC to make that unambiguous.

## Cleared

Checked and found sound within the amendment scope. V7 items resolve as follows:

- V7-F1 facts and ordering: resolved. Wire bodies `{kind: "publication-requested", actionId}` and `{kind: "publication-connection-failed", actionId, reason, message}`, envelope `{v: 1, src: "execution", payloadVersion: 2, at, connection: body}`, parser ownership with `invalid-connection`, request-before-failure with `connection-not-admitted`, `nativePublication` retention with action map and latest failure, idempotent identical repeats, `connection-conflict` on reused ID with different content, host-selected request ID with caller-supplied divergence rejected, new ID per changed failure, history append with latest-only projection including after binding, no binding mutation, append-lock-only writes with no registration lock or native inspection, binding keeps registration-before-record order. Rung 1 on text; the `ChannelState.nativePublication` field and `ConnectionFact` union members do not exist in this snapshot, which is expected for an unimplemented spec.
- V7-F2 predicate: resolved. `requiresNativeConnection(state)` is true exactly when `state.nativePublication !== null || state.connection !== null`, replaces the bound-only guard, covers `requested`, `retry-authorized`, and `fresh-authorized` with no exemption, keeps native eligibility bound-only, repeats under the `attempt-started` transaction, before and after lease acquisition, at attachment and every final dispatch, with no artificial revision or hash. Ordinary records (both null) stay eligible; bound records keep the existing fence. The per-callsite wiring (`src/store/managed-readiness.ts:29-43`, `src/modes/managed-preparation.ts:143-203`, host admission, `src/server/managed-launch.ts:46`, runtime admission, per-turn dispatch) is a requirement left for implementation. Rung 2.
- V7-F3 race: resolved in design. Separate append transactions for requirement, artifact write, and binding, no lock spanning admission, filesystem work, or registration lookup, with the explicit predicate guard authoritative at dispatch time. Stamp, prerequisite-hash, and revision mechanisms are explicitly excluded as substitutes. Rung 2 with `src/modes/managed-preparation.ts:143-203` and host `captureDispatch`/`writePreparedExecution` as the implementation seam.
- V7-F4 dispatch boundary: resolved except V8-1 above. `attempt-started` as preparation evidence, dispatch as ordered admission of one synchronous callback consumed before invocation without awaiting under the append lock, `dispatch-not-called` where the managed attempt supports it, settle-through-owner with existing uncertainty rules and no second invocation, coverage of managed and non-managed paths, no cursor advance on withholding. Rung 2.
- V7-F5 readers: behavior resolved, code name not (see V8-2). Refusal without mutation or launch, no skipping, no downgrade even after settlement or copy/backup, HTTP store-failure mapping with nonzero CLI exit, acceptance against actual emitted facts with unchanged bytes and zero creation. Rung 4 for the refusal behavior as probed; rung 2 for the code-name drift.
- V7-F6 projection and drafts: resolved except V8-3 precedence and reason-list items. `nativeConnectionRequired` as required top-level boolean in CLI JSON and browser HTTP, `setup-required` reuse, failure as last attempt, `setup-instructions` only, empty actions under uncertainty with setup failure kept as history, null identity, ordinary records false, draft semantics independent of execution entries. Rung 2 against `src/protocol/connection-status.ts:7-22`, `src/store/connection-view.ts:328-349`, `src/server/client/native-connection.tsx:38-39`.
- V7-F7 write-failure path: resolved. `connection.persistence` `saved` versus `unverified`, published status/version/URL retained, `setup-required` with `connection-result-unrecorded`, success as publication operation, non-durable `attempt` with reason/message only, host-selected IDs on retry, replay showing last stored failure or incomplete state, no HTTP publication mutation. Rung 1.
- V7-F8 retry identity: resolved. Original creation key or conversation ID with same identity/version/bytes when saved, empty-draft correction allowed, subsequent revision under new-version rules, same-version changed bytes refused by the existing artifact conflict rule, distinct failures appended with latest-only projection, post-binding failures as history with bound projection winning, host-generated request ID. Consistent with `src/cli/artifact-publish.ts:146-155`. Rung 2.
- V7-F9 held draft: resolved. Crash before write leaves held draft, crash after write leaves held readable artifact, refused write retains requirement, version, and feedback, hold independent of execution entries. Rung 1.
- V7-F10 lock order: resolved except V8-4 wording. Requirement and failure writes use the existing host connection transaction under the record append lock only, no registration lock, no native inspection, binding keeps registration-before-record order. Rung 2 against RFC lines 201-203 and `src/cli/artifact-publish.ts:58-195`.

High-priority properties hold as specified: no fresh-session fallback, no optimistic ownership, no lost accepted input, no dispatch after a racing requirement commits, old readers refuse critical facts without mutation or launch, settled work is not replayed, no automatic native identity migration, ordinary managed records are unchanged, only an explicit new publication attempt opts in, saved preference never selects the unbound state.

## Not reviewed

- Full v6 implementation correctness beyond the amendment touch points.
- Native acceptance lanes for Codex CLI, Codex desktop, Claude CLI, Pi CLI, and Muse CLI. Open Questions 1-2 leave them pending.
- HCN `interactive` operation internals beyond the amendment reference.
- Exact UI copy, layout, breakpoints, themes, and live-region behavior for the unbound setup surface.
- Performance, log growth, or action-ID storage bounds for repeated failures.
- Reads outside the snapshot, native transcripts, credentials, environment, history, shell, network, or agents. All findings above come from the RFC text, `publication-failure-probe.json`, the deterministic structure file, and direct snapshot reads.
