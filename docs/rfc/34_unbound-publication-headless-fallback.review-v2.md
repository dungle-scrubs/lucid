# Review: RFC 34 v2 - Unbound publication falls back to headless with the producer's settings

Reviewer family: Muse. Target: `docs/rfc/34_unbound-publication-headless-fallback.rfc.md` v2 (Draft), branch `rfc/34-unbound-publication-headless-fallback`, commit 9b6819e. Review only; no RFC or source edits made.


## Verdict: conditional - address the one major finding, then accept

v2 answers every v1 disposition honestly. I checked each row of the "Response to v1 review" table against the v2 text and the code; the dispositions are accurate with only small gaps (see disposition notes). The terminal-`publication-fallback` design resolves the v1 re-arm contradiction cleanly, the two-append ordering is now specified with interleave and crash analysis, and the `registration-missing` signal claim is narrowed with an owned residual risk.

One major finding blocks acceptance as written: the healing story for the observed record contradicts the settings-immutability rule, which makes Implementation Plan step 7 unachievable on record `40cf7112` (R34-18). The rest are minors and observations.

## Disposition check: v1 findings against v2

- R34-01 (released field / hold-released collision): Applied, verified. v2 specifies fact body exactly (`section 2`), the `NativePublication.fallback` field with type and `null` initial value, and states `holdRelease` is unchanged. No residual.
- R34-02 (re-arm contradiction, repeat rules): Applied, verified. Re-arm is removed and fallback is terminal (`section 3`). Action-ID derivation is stated (`section 4`: reuse existing `fallback.actionId`, else new UUID; failure-ID reuse via the host op I confirmed at `src/store/conversation-host.ts:1178-1181`). The derivation composes correctly with the guard table: after fallback, failures are refused so the failure cannot change, and a repeat fallback fact is byte-identical, so the top-of-reducer no-op rule (`src/protocol/connection.ts:996-1002`) applies. No residual.
- R34-03 (same-transaction claim): Applied, verified. `Section 4` specifies two ordered appends, the interleave case (a different-reason failure landing between the appends makes `failureActionId` stale and the reducer refuses, record stays held), and crash recovery via repeat publication. The cited mechanism (`writeConnection` takes one fact per call; `recordNativePublication` reuses `requestedActionId` at `src/store/conversation-host.ts:1186-1188`) matches the code. No residual.
- R34-04 (registration-missing overstatement): Applied, verified with one gap. Security now says `registration-missing` proves no verified registration is an ancestor, names the not-yet-written window (hook startup ordering, outside Lucid's control), and gives recovery (new conversation from the live session). Gap: the prune path is a second false-fallback vector the RFC does not name; see R34-19.
- R34-05 (guard set): Applied, verified. The vacuous reconnect guard is dropped with a correct justification (reconnect needs a binding, `src/protocol/connection.ts:1080-1082`, which I confirmed). F2/F4 are cited for the no-in-flight argument and surviving fences (`holdRelease`, uncertain outcome, presence lock / executor lease, dispatch-boundary recheck) are listed in `section 5`. One explanatory gap; see R34-20.
- R34-06 (schema / writer path): Applied, verified. `Section 1` names `origin` as the only new field and `createConversationRecord` as the writer, matching `src/store/creation.ts:81-86` and `src/cli/artifact-publish.ts:163-176`. No residual.
- R34-07 (unnamed RFC 26 amendments): Applied, verified with one gap. The "Amendments to RFC 26" section lists seven items covering the v1 concerns. Gap: one F1 sentence is still unlisted; see R34-22.
- R34-08 (probe trust assumption): Applied, verified. `Section 8` states the assumption (registered owners are fully readable: same-user corroboration at write time plus same-uid private store) and the no-match-authority rule for the skipped process. The upward-skip logic is sound (see "Confirmed claims"). No residual except the Linux scope note; see R34-23.
- R34-09 (origin line): Applied, verified. `Section 7` gives the fresh-intent rule (not turn count, so `continue-fresh` also gets the line), placement relative to the reference block I confirmed at `src/modes/managed-preparation.ts:331-341`, numeric bounds in `section 1`, the absent-origin skip, and the pointer-not-payload size note. No residual.
- R34-10 (once-each dispatch): Applied, reviewed-as-stated. `Section 5` gives the ledger-and-cursor argument and the lock/lease rechecks. I did not independently verify the execution-ledger identity mechanics; the argument is coherent at RFC level.
- R34-11 (projection mapping): Applied, verified. `Section 5` specifies the `observeConnection` check order, state/reason/message/actions/`nativeConnectionRequired: false`, `awaitingNativeBinding` false via the predicate, CLI parity, and the RFC 26 table row. I confirmed the `actions: []` outcome independently: with the predicate false, `connectionActions` falls through the `awaitingNativeBinding` gate (`src/store/connection-view.ts:449`) and the undefined native interface hits the early `return []`. One ordering detail for implementers; see R34-24.
- R34-12 (residual defaults): Applied, verified. `Section 1` rule 2 states defaults hold when `settings` is absent and the defect is fixed only for declaring publishers. No residual.
- R34-13 (driver-preference comment): Applied, verified against `src/store/driver-preference.ts:14-17`. Rule 7 names the carve-out edit. No residual.
- R34-14 / R34-15 (ADR 0005 / 0009): No change needed, agreed. The no-inference rule, the creation-only rule, and the provenance fencing (`origin` never passed to hcn as a resume target) hold both boundaries.
- R34-16 (migration decision): Applied, verified. Repeat-publication healing is specified (`section 4`), status-read healing is rejected in Alternatives (consistent with RFC 26 read-only status). But the healing story misses the settings interaction; see R34-18.
- R34-17 (copied-record portability): Applied, verified. `Section 7` (missing file is normal tool failure) plus the Security line on carried absolute paths. No residual.

## Confirmed claims (verified, no change needed)

- Hold and settings diagnoses repeat the v1 confirmations and still match the code: predicate at `src/protocol/connection.ts:328-330`, `managedCandidates` early return at `src/store/managed-readiness.ts:36`, defaults path at `src/cli/artifact-publish.ts:169-176`, preference write at `src/store/creation.ts:84`, preference read at `src/modes/managed-preparation.ts:265`.
- Failure-reason diagnosis: the walk returns `undefined` on the first unreadable ancestor (`src/store/native-registration.ts:73-86`) and the aggregator maps no-match-plus-unknown to `owner-unknown` (`src/store/native-registration.ts:288-289`). The Ghostty/`login` ancestry producing `owner-unknown` follows.
- Parent-only probe soundness: skipping an unreadable ancestor and continuing from its kernel-reported parent PID cannot manufacture a false ancestry match, because every process at or above the skipped one is still a genuine ancestor of the caller. The spoofable surface is the PPID value itself, which comes from the kernel, and any match still requires PID plus start-time plus executable corroboration plus the separate owner-presence check. The existing walk already carries the same PID-reuse TOCTOU, so the change adds no new trust class. Rules 2-4 (no match authority for the skipped process, `undefined` only on probe failure / cycle / depth limit, `false` at PID 1) match the current code shape (`src/store/native-registration.ts:73-86`).
- The `connection === null` guard plus the append lock resolves the bind-vs-fallback race deterministically: whichever fact (a verified `bound` from an integrated caller, or `publication-fallback`) commits first decides, and the guard table refuses the loser. Both outcomes are safe (native delivery under RFC 26 guards, or terminal managed delivery). The RFC does not state this explicitly; see R34-25.
- Concurrent duplicate publishers converge to fallback: identical reason plus message reuses the failure ID under the append lock (`src/store/conversation-host.ts:1178-1181`), making both the failure and the fallback repeats byte-identical no-ops; differing messages serialize so that only the fallback naming the current failure is accepted. This falls out of the specified rules and needs no RFC change, noted here as a positive check.
- Pre-amendment reader behavior (`invalid-connection` refusal, no downgrade) is consistent with RFC 26 F5.

## Major findings

### R34-18 (Major): healing the observed record fixes the hold but not the settings, and Plan step 7 is unachievable as written

Evidence: `section 1` rule 4 says `settings` applies only on creation, and a publication into an existing conversation must not change the driver preference. The publish path confirms it: settings are consumed only in the creation branch (`src/cli/artifact-publish.ts:162-185`); the conversation-ID path skips creation entirely. The RFC's own Acceptance restates it ("A publication into an existing record does not change the driver preference or `origin`").

`Section 4` says repeating the same publication heals record `40cf7112` (whose last failure is `owner-unknown`): after `section 7` ships, the repeat produces `registration-missing`, then the fallback. That heals the hold. But the original publication sent no `settings`, so the record's saved preference is the `claude`/`opus`/`high` defaults, and the repeat cannot change it under rule 4. The healed record therefore falls back to a headless session on the defaults, not on `pi`/`zai`/`glm-5.3`.

Plan step 7 says to repeat the publication for `40cf7112` and "confirm that a browser note gets a reply from a headless `pi` / `zai` / `glm-5.3` turn." That confirmation cannot come from the healed record. If the defaults' harness or model is unavailable in the environment, the note will instead hit the existing managed-preparation refusal with `change-settings` (`src/modes/managed-preparation.ts:265-278`), which is the correct behavior but not what the step asserts.

RFC landing: `sections 1` (rule 4), `4` (healing paragraph), `7` (plan step 7), Acceptance. Required: state explicitly that a healed pre-existing record falls back with its original (possibly default) settings and that the person's Settings change is the remedy for the model mismatch; split step 7 into (a) a fresh publication with declared settings confirming the `pi`/`zai`/`glm-5.3` headless turn, and (b) a repeat publication on `40cf7112` confirming fallback-with-defaults plus the `change-settings` path. The Introduction presents `40cf7112` as exhibiting both the hold and the wrong-settings defects; the RFC must not let the reader conclude one repeat fixes both.

## Minor findings and observations

### R34-19 (Minor): Security names one false-fallback vector but not the prune path

Evidence: registrations whose owner probe returns confirmed-absent are unlinked before matching (`src/store/native-registration.ts:269-274`). A transient false presence observation (for example PID reuse or a momentary probe failure that reads as absent rather than unknown) prunes a live session's registration, and that session's next publication then reports `registration-missing` and falls back terminally. This is the same shape as the named not-yet-written window, with the same recovery, and deserves one sentence alongside it. RFC landing: Security Considerations, first bullet.

### R34-20 (Minor): section 5 credits F2/F4 for work the legacyDelivery guard does

Evidence: for a publication into an existing record with a managed attempt already in flight, the no-in-flight property at fallback time comes from the guard-table row `hasUnsettledPublicationDelivery(state) === false`, because `legacyDelivery` captures the in-flight count and uncertain inputs at the request transition (`src/protocol/connection.ts:1024-1035`) and only `done` events in the same epoch retire them. F2/F4 cover only attempts that would start after the requirement. The guard set is complete (legacyDelivery plus F2/F4 plus the surviving uncertain-outcome fence in `src/store/managed-readiness.ts:40-44`), but the explanatory paragraph attributes everything to F2/F4. RFC landing: `section 5`, first two paragraphs. One sentence crediting the `legacyDelivery` row for the pre-requirement case closes it. Related consequence worth stating: a pre-requirement attempt that ends `uncertain` never retires its captured count, so such a record stays held forever, which is consistent with RFC 26's no-reset rule and with the Acceptance line on uncertain legacy delivery.

### R34-21 (Minor): origin validation scope on existing-record publications

Evidence: `section 1` rule 5 refuses the whole request with `E-HUB-03` on invalid `origin`, while rule 5 also says `origin` applies only on creation. A repeat or add-version publication into an existing record carrying a stale or malformed `origin` would therefore have its artifact write refused over a provenance-only field that the RFC says has no effect there. RFC landing: `section 1` rule 5. Required: validate (and refuse on) `origin` only for creation publishes; ignore it otherwise. This matches the settings precedent (absent settings keep defaults on creation; sent settings are inert on existing records).

### R34-22 (Minor): one F1 sentence and the old section 8 row need explicit scoping

Evidence: RFC 26 F1 says distinct failed attempts append history and replace the latest failure projection "including after binding," but `section 3` rule 2 refuses any `publication-connection-failed` after fallback. That is a deliberate carve-out for fallback records and belongs in the Amendments list. Likewise, amendment 6 adds the `headless-fallback` row, but the pre-existing "Publication succeeded, integration missing" row should be scoped to reasons other than `registration-missing` so implementers know which row owns a fallback-ineligible hold such as `owner-unknown`. RFC landing: Amendments to RFC 26, items 2 and 6.

### R34-23 (Minor): the ancestry defect persists on non-Darwin platforms with no fallback

Evidence: `section 8` scopes the probe to Darwin and keeps current behavior elsewhere. On Linux the same ancestry shape (root-owned `login`/`sshd`/`systemd` ancestors unreadable via `/proc`) still yields `owner-unknown` through `absentOrUnknown` (`src/process-owner.ts:25-32, 34-58`), and `owner-unknown` never triggers fallback, so the dead end this RFC removes on Darwin remains on Linux. That is a defensible scope cut, but the RFC should state the consequence in one line (Linux records with root-owned ancestry stay held with `owner-unknown`) rather than leaving "keeps its current behavior" to imply equivalence. RFC landing: `section 8`, final paragraph.

### R34-24 (Minor): specify the fallback check order against the legacyDelivery checks in observeConnection

Evidence: the unbound branch checks `uncertainInputs` then `inFlight` before `setup-required` (`src/store/connection-view.ts:66-95`), while `section 5` says the `fallback` check comes "before its unbound branch" without saying whether it precedes those two delivery checks. The guard table makes the order moot for a correctly written fallback (delivery is settled at write time, and the captured counts cannot grow afterward since only dispositions for captured uncertain inputs increment them), but implementers should not have to re-derive that. RFC landing: `section 5`. One sentence: check `fallback` first and return `headless-fallback` directly, with the justification that the write-time guard guarantees settled delivery.

### R34-25 (Info): state the bind-vs-fallback race outcome explicitly

As analyzed under Confirmed claims, a verified bind and a fallback racing on the same never-bound record resolve by append order and both outcomes are safe. The RFC never names the cross-caller case (an integrated session binding a record that a non-integrated publisher created). One sentence in `section 4` or `section 3` would prevent implementers from adding a redundant guard. No normative change needed.

## What was not checked

No test suite was run (review-only brief). The probe measurement (`872 to 741` via `PROC_PIDT_SHORTBSDINFO`) is taken on the author's report; Implementation Plan step 1 (injected-probe test plus live Pi ancestry confirmation) is the right cover and should be treated as gating that section. The input-ledger and delivery-cursor mechanics behind the once-each dispatch claim were reviewed as stated, not traced to the ledger code. Line citations are to the checked-out branch text at commit 9b6819e.

