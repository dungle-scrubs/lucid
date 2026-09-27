
# Review: RFC 34 v1 - Unbound publication falls back to headless with the producer's settings

Reviewer family: Muse. Target: `docs/rfc/34_unbound-publication-headless-fallback.rfc.md` v1 (Draft), branch `rfc/34-unbound-publication-headless-fallback`, commit 98925e6. Review only; no RFC or source edits made.

## Verdict: conditional - address the blockers, then accept

The diagnosis is accurate and I verified each leg against the code (see "Confirmed claims"). The design direction (declare producer settings, release on no-integration failure, fix the probe reason) is sound and holds scope. But the protocol amendment is underspecified in ways that block implementation: the proposed state field does not exist, re-arm contradicts an existing reducer refusal, the "same transaction" claim is inaccurate, and the central safety claim about `registration-missing` overstates what the signal proves. Findings R34-01 through R34-05 are blockers. The rest are major/minor and mostly require the RFC to say what it is already doing.

## Confirmed claims (verified, no change needed)

- Wrong-settings diagnosis: `publishArtifact` uses `readUserConfig().defaults` (`claude`/`opus`/`high`) when `settings` is absent, and passes `workingDirectory` through to creation - `src/cli/artifact-publish.ts:163-176`, `src/config/user-config.ts:22-27`, `src/store/creation.ts:20-31`.
- Hold diagnosis: `requiresNativeConnection` is true for any record with `nativePublication !== null` - `src/protocol/connection.ts:328-330`; managed candidates return `[]` under it, so the saved preference selects nothing - `src/store/managed-readiness.ts:36`.
- Projection diagnosis: unbound records project `setup-required` with null native identity - `src/store/connection-view.ts:66-95,438-440`.
- Failure-reason diagnosis: `callerAncestryOwns` returns `undefined` on the first unreadable ancestor (`src/store/native-registration.ts:73-86`), and `withNativeRegistration` maps "no match + any unknown" to `owner-unknown` (`src/store/native-registration.ts:281-289`). A root-owned `/usr/bin/login` ancestor producing `owner-unknown` instead of `registration-missing` follows from the code, given the DARWIN `proc_pidinfo` readability assumption.
- Bound-record exclusion is correct: binding guards refuse when unsettled work exists (`src/protocol/connection.ts:1044-1048`), and failures after binding only replace failure history without mutating the binding (`src/protocol/connection.ts:1006-1039`). RFC 34's `connection === null` guard preserves this. Good.
- Managed preparation does read the driver preference (`src/modes/managed-preparation.ts:265`), so creation-time settings do reach later headless turns. The execution path after release works as described.

## Blockers

### R34-01 (Blocker): the proposed `released` state does not exist and collides with `hold-released`

Evidence: `NativePublication` is `{actions, failure, legacyDelivery, requestedActionId}` with no `released` field (`src/protocol/connection.ts:312-326`). The proposed predicate `state.nativePublication.released === null` (`RFC 34 §2 rule 3`) references a field that is not specified anywhere as an interface change. Separately, the codebase already has a `hold-released` fact and `ChannelState.holdRelease` used by the detach/handoff path (`src/protocol/connection.ts:343,1000,1040-1042`; `src/protocol/reducer.ts:143`; `src/store/managed-readiness.ts:39`; `src/store/connection-view.ts:330-341`), which is single-shot by design (`connection-conflict` on repeat, `connection.ts:1041`) and means something different (executor detach, not requirement release).

RFC landing: §2 rules 2-3, Implementation plan step 1. Required: specify the exact `NativePublication` field (name, type, initial value), the exact `publication-released` body shape in `parseConnectionFact` terms (both IDs as `connectionId` UUIDs), and a statement that `holdRelease` is untouched. Recommend naming it `released` on `NativePublication` only if the RFC also renames or explicitly disambiguates `hold-released`; otherwise pick `publicationReleased` to avoid a two-meaning "release" vocabulary.

### R34-02 (Blocker): re-arm contradicts the existing second-request refusal; release idempotency is underived

Evidence: a second `publication-requested` with a different action ID is `connection-conflict` today (`src/protocol/connection.ts:1008-1013`), and the host reuses `requestedActionId` on repeat (`src/store/conversation-host.ts:1186-1188`). RFC 34 §2 rule 4 ("a new `publication-requested` clears `released` and re-arms") therefore requires a reducer amendment that is never specified: which action ID does the re-arming request carry, what happens to the `actions` map, and does the conflict rule gain a released-record exception?

Related: §2 rule 2 says "an identical repeat changes nothing," but release action IDs are never given a derivation. If they are `randomUUID` per attempt, repeats produce distinct facts and the reducer needs an explicit "already released with the same `failureActionId` -> accept as no-op" rule; if they are derived from the failure ID, say so. The same gap applies to the Error-handling claim "repeating the same publication retries the release": trace shows retry reuses the failure ID only when reason+message are identical (`src/store/conversation-host.ts:1178-1181`), so the release-retry story must be specified in terms of that reuse.

RFC landing: §2 rules 1-2, rule 4; Error handling; Acceptance ("a repeat publication releases it", "re-arms, and then binds or releases again").

### R34-03 (Blocker): "same host connection transaction" is inaccurate; the window needs a two-append specification

Evidence: `writeConnection` performs one fact per `transactDynamic` call (`src/store/conversation-host.ts:1048-1084`), and `recordNativePublication` writes one fact per call (`src/store/conversation-host.ts:1172-1191`). Failure and release are two appends in two transactions, with a crash and an interleave window between them. The RFC's own Error handling ("the release append fails after the failure fact was stored: the record stays held") concedes the crash window, which contradicts rule 1's "in the same host connection transaction."

RFC landing: §2 rule 1, Error handling. Required: rewrite rule 1 as two ordered appends (failure, then release), state that a concurrent third-party append between them is harmless because each fact is independently validated by the reducer, and keep the retry rule. The retry path already works through failure-ID reuse, but only when stated (see R34-02).

### R34-04 (Blocker): `registration-missing` does not prove "no native session exists that could receive the input"

Evidence: `registration-missing` means no live registered owner is an ancestor of the calling process (`src/store/native-registration.ts:281-300`). It is also the result when the integration is installed but the registration was never written, was pruned after a transient dead-owner observation (`src/store/native-registration.ts:269-274`), or could not be read under lock contention (reported as `registration-busy` / `registration-store-unavailable`, correctly excluded, but the adjacent "not yet written" case is not). A live native session that publishes before its registration lands gets `registration-missing`, and under this RFC its record permanently loses the native hold, with recovery only via republish-and-bind. The Security claim ("no native session exists that could also receive the input," RFC 34 Security §1) therefore overstates the signal: it proves absence of a verified registration, not absence of a live session.

RFC landing: §2 rule 1, Security §1, Open Question 3. Required: narrow the claim to "no verified registration," analyze the not-yet-registered race explicitly (register-then-publish ordering is outside Lucid's control for CLI publishers), and state the residual risk plus recovery (republish re-arms per rule 4; if that binding succeeds, RFC 26 governs). Automatic release may still be the right call, but the RFC must own the false-release case instead of defining it away.

### R34-05 (Blocker): the release guard set is incomplete as stated, and one guard is vacuous

Evidence: (a) "No reconnect reservation exists" is vacuous alongside `state.connection === null`: `reconnect-requested` without a binding is `connection-not-admitted` (`src/protocol/connection.ts:1080-1082`), and `currentReconnect` reads from `connection` (`src/protocol/connection.ts:107-111`). Name what this guard actually excludes or drop it. (b) The guard set never mentions ordinary unsettled executions (`hasUnsettledExecution`) or the independent uncertain-outcome fence (`src/store/managed-readiness.ts:40-44`), which still returns `[]` after release. A released record with a pre-publication uncertain managed outcome stays undispatchable; that is correct behavior, but "a released record is an ordinary managed record" (§2 rule 3) must say so, or the Acceptance line "dispatches a note saved before release" will confuse implementers when the other fence holds. (c) The reason no post-requirement managed attempt can be in flight at release time is RFC 26 F2/F4 (predicate rechecked at attempt creation, executor acquisition, and the dispatch boundary), which the RFC never cites. The guard set reads as self-sufficient; it is only sufficient in combination with those checks.

RFC landing: §2 rules 1, 3; Acceptance. Required: restate the guard set as (i) reason is `registration-missing`, (ii) never bound, (iii) `hasUnsettledPublicationDelivery` false, (iv) no unsettled ordinary execution relevant to the record, with (iv) justified by citing F2/F4 rather than re-proving it; note the surviving uncertain-outcome fence.

## Major findings

### R34-06 (Major): §1 misdescribes the request schema and the writer path

Evidence: `settings` and `workingDirectory` already exist on the publication request path (`src/cli/artifact-publish.ts:85,163-176`; `src/store/creation.ts:20-31`). Nothing about the request "gains one optional object" except `origin`. What is new is skill behavior (send them) plus `origin` metadata, not protocol fields. Also "through the existing `driver-preference` writer" is inaccurate: creation writes the initial preference via `createConversationRecord` (`src/store/creation.ts:81-86`), not `writeDriverPreference`. RFC landing: §1 rules 1-2, 5; Implementation plan step 3. Fix the description; the normative content (settings apply only at creation, §1 rule 4) is right and should stay.

### R34-07 (Major): the RFC amends RFC 26 in at least five places it does not name

RFC 26 states: "There is no clear-requirement or convert-to-managed action in this amendment" (RFC 26 lines 94-95); F1 wire bodies "are exactly" the two kinds (line 105); a second request ID is refused (line 105, and `connection.ts:1008-1013`); "Saved preference never selects this state" (line 97); and the §8 table row for integration-missing prescribes setup instructions with the record held (lines 176-178). RFC 34 changes or carves out each of these for the `registration-missing` sub-case but never lists them. RFC landing: new "Amendments to RFC 26" section required; also touch the §8 table row and the F6 sentence. Without this list, implementers cannot tell which RFC 26 sentences remain normative.

### R34-08 (Major): the parent-only probe needs its trust assumption stated

The probe change is correctly shaped (PID only, no match authority, §4 rules 1-2), and the no-false-match argument holds as long as every registrable owner is fully readable by the publisher. That assumption should be written down: registration requires same-user corroboration at write time (`src/store/native-registration.ts:235-239`) and a same-uid private store (`src/store/native-registration.ts:131-138`), so a same-user publisher can fully read any genuine owner process and the fallback only skips genuinely foreign (root-owned) PIDs. The remaining edge, an owner PID that is itself unreadable, would now release instead of hold; the RFC should say why that cannot be a registrable owner rather than leaving it implicit. The Darwin-only scope and injected-probe testing plan are right. RFC landing: §4, Security §2.

### R34-09 (Major): the first-dispatch origin line is undermarked for implementation

Missing: the "first dispatch" marker (e.g., harness session state unset for the producer harness), numeric bounds for `origin` fields (recommend mirroring `path()` 4096/absolute/control-free, `src/protocol/connection.ts:572-576`, and wire-ID 128 for IDs), where the line lands in prompt composition relative to the existing reference block (`src/modes/managed-preparation.ts:331-341`), behavior when `origin` is absent (skip, no failure), and the context-window cost note for a "read it if needed" pointer to an unbounded session file. RFC landing: §3, Acceptance ("first dispatch includes the origin line; second does not").

### R34-10 (Major): the once-each dispatch claim needs its idempotency argument

Acceptance requires a pre-release note and a post-release note to each dispatch once. The mechanism (input ledger identity + delivery cursor; pre-release inputs carry `requested`-kind execution entries that become managed candidates after release) is plausible but unstated, and the presence-lock/executor-lease handoff across the release boundary is never walked through. One paragraph in §2 rule 3 closing the loop. RFC landing: §2 rule 3, Acceptance.

### R34-11 (Major): the `released` projection state needs a mapping, not just a name

The state vocabulary consumed by `connectionActions` and the browser does not contain `released` (`src/store/connection-view.ts:445-468`; `awaitingNativeBinding` gate at 449). Specify: `observeConnection`'s `nativePublication` branch (`src/store/connection-view.ts:66-95`) checks the released marker first and returns the new state/reason/actions/`nativeConnectionRequired: false`; `awaitingNativeBinding` is false for released records. Also update the RFC 26 §8 table (see R34-07). RFC landing: §5, §2.

## Minor findings and observations

- R34-12 (Minor): residual defaults population. §1 rule 2 keeps user-config defaults when `settings` is absent, so publishers with old skills still get `claude`/`opus` after release. That is a defensible compatibility choice, but the RFC should state the residual explicitly: the observed defect is fixed only for publishers that declare settings (i.e., after the out-of-repo skill update, plan step 6). RFC landing: §1 rule 2, §5, Acceptance, Plan.
- R34-13 (Minor): `driver-preference.ts` module comment says the file's only writer is the server on the browser's behalf (`src/store/driver-preference.ts:13-29`), which already strains against creation-time preference writes and strains further under publisher-declared initial preferences. Add the carve-out (§1 rule 4 covers the semantics; the comment needs the matching edit).
- R34-14 (Info): ADR 0005 consistency holds. §1 rule 3 (no inference from artifact text/process table/session files) and Alternatives (rejecting Pi-session-file reading, Open Question 1 proposing an hcn operation instead) are the ADR-0005-clean posture. §3's agent-read pointer is not Lucid-side derivation and is fenced ("never passed to hcn as a resume target"), so it stays inside the boundary; keep that fencing sentence wherever §3 lands in implementation.
- R34-15 (Info): ADR 0009 consistency holds with the §1 rule 4 carve-out (publisher sets the initial preference; the person's Settings choice wins after creation). No change beyond R34-13's comment edit.
- R34-16 (Minor): Open Question 3 is really a migration decision, and the Introduction's record `40cf7112` needs one republish under this draft. Recommend the RFC take a position (status-read migration vs. republish-only) rather than shipping the question, since it determines whether dead-end records from the observed incident ever heal.
- R34-17 (Minor): `origin.sessionFile` travels in record metadata beside `creation.request`, so it is copied with the record. Same-account, same-access reasoning (Security §3, citing the RFC 32 boundary) covers the live case; add one line on copied-record portability (stale absolute path degrades to the agent's normal tool failure, consistent with §3's missing-file rule).

## What was not checked

No test suite was run (review-only brief); no skill body was read (the `review-rfc` skill is disabled this session, and the lucid skill source lives outside the repo at `~/dev/skills`). Line citations above are to the checked-out branch text.
