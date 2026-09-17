# Re-review: RFC 30 v2 (native feedback context by reference)

Scope: read-only. RFC v2 (`docs/rfc/30_native-feedback-context-by-reference.rfc.md`) checked against v1 review (`docs/rfc/30_native-feedback-context-by-reference.review-v1.md`) and current code. No files changed.

## 1. V1 finding resolutions

| ID | Status | Evidence |
|---|---|---|
| R1 (false compat claim) | Resolved | §1 now states field-by-field parse with unknown fields ignored, matching `parseConnectionFact` for `offer-started` ([connection.ts](src/protocol/connection.ts:881)), and justifies no `payloadVersion` change (live guard, one binary). Minor gap: acceptance lists "malformed `delivery` refused; logs without it replay unchanged" but no new-log-on-old-parser downgrade test that v1 required. |
| R2 (no home for read gate) | Resolved | §4 names `controlConnection` as the live-writer home with facts unchanged so replay bypasses the check. This is sound: replay folds through `reduceConnection` ([connection.ts](src/protocol/connection.ts:973)), never through `controlConnection` ([conversation-host.ts](src/store/conversation-host.ts:1358)). Minor gap: outcome parsing/validation before the kind check is unspecified (see V2-6). |
| R3 (`sending` brick) | Resolved | Moving the gate from receipt to answer/question responses removes the strand: receipt is unconditional ([connection.ts](src/protocol/connection.ts:1482)), and every `received` offer can finish via refusal/failure, which skip the check. Residual exposure remains (see V2-5). |
| R4 (owner-exit reaping) | Resolved | §4 exit via failure covers copy loss; reaper described as lazy with unknown-ownership retention, matching `reapContextOffers` ([context-offer.ts](src/store/context-offer.ts:76)) and cleanup on accepted outcome ([conversation-host.ts](src/store/conversation-host.ts:1073)). |
| R5 (emission vs use, subagent) | Resolved on spec | §2 states the check proves ordered printing, not use, and explicitly accepts subagent reads. Minor gap: v1's required subagent test is absent from acceptance. |
| R6 (copy/progress checks) | Partly resolved | Progress checks (§2) match `readContextProgress` ([context-offer.ts](src/store/context-offer.ts:312)); byte domain defined (§1, post-header). But §2's gap refusal contradicts the implemented reader (see V2-1); lookup TOCTOU/canonicalization is unspecified (see V2-7); the uid requirement's target is ambiguous (see V2-9). |
| R7 (concurrency/retry) | Resolved on spec | §4 states refusals leave the offer `received`, rereads allowed (§2), no re-preparation. The lost-race sentence is inaccurate (see V2-2). |
| R8 (slice probe) | Partly resolved | Probe table, 24,000 value, and margin reasoning present; acceptance covers refused-then-accepted through PostToolUse. Missing: `BASH_MAX_OUTPUT_LENGTH` calibration (see V2-3); proposal-TTL/paging-budget expiry behavior unaddressed. |
| R9 (hold notice) | Partly resolved | Filter (own participation, in order), offered/interrupted exclusions, block-cap precedence all specified. But the result shape has no consumer (see V2-4). |
| R10 (order, copy helper) | Resolved | Order in §1 matches `prepareNativeFeedback` ([native-preparation.ts](src/modes/native-preparation.ts:44)); plain `offerContext` pinned with reason; acceptance covers attachments/comparison no-copy. |
| R11 (bytes domain) | Resolved | `delivery.bytes` defined post-header, `C` in the same domain, matching `file.size - HEADER.length` ([context-offer.ts](src/store/context-offer.ts:387)). |
| R12 (refusal names) | Resolved | New `context-unread`/`context-missing` avoid the `context-unavailable` preparation collision; messages assigned to `connection-control.ts` (implementation still to do: `REFUSAL_ISSUES` ([frames.ts](src/protocol/frames.ts:84)) and `refusalMessage` ([connection-control.ts](src/cli/connection-control.ts:50)) lack them). |
| R13 (acceptance) | Partly resolved | Greatly expanded. Still missing: downgrade replay test, subagent test, notice negative cases (offered/interrupted emit nothing). |
| R14 (alternatives) | Resolved | Per-slice (Stop cap counting, history growth, offer multiplication) and managed-path (breaks same-session rule) both justified; digest, receipt-check, always-reference, Read-tool cases covered. |

## 2. New defects in v2

### V2-1. Blocking. §2 "refused gap" contradicts the implemented reader.

§2 says "A read at `offset > C` is refused". The landed implementation serves it: `readOfferedContext` performs no progress comparison, and `recordReadProgress` is explicitly "served but does not extend it" ([context-offer.ts](src/store/context-offer.ts:296), ([context-offer.ts](src/store/context-offer.ts:342)). The acceptance criterion "The reader refuses a gap" would fail against this code.

Required change: align spec to serve-but-don't-extend (preferred; refusing gaps would also force a behavior change on the managed/headless read path that shares `readOfferedContext`), and rewrite the acceptance line to "an out-of-order read is served but leaves `C` unchanged until the prefix is reread in order".

### V2-2. Major. Lost-race sentence misdescribes `recordReadProgress`, and stale skips force rereads the RFC never mentions.

§2 claims a lost race "can only lower `C` to a value a reader already reached, which a reread restores". The code path that actually bites is the opposite: `recordReadProgress` snapshots a stale `C`, sees `offset > contiguous`, and skips a successfully served read ([context-offer.ts](src/store/context-offer.ts:343)). Progress then understates completed reads, and the session must re-read an already-read chunk before `C` advances.

Required change: replace the sentence with the real invariant (writes are monotonic-guarded; a stale snapshot skips, never corrupts) and state that a served-but-unrecorded chunk must be reread once the prefix catches up.

### V2-3. Major. The `BASH_MAX_OUTPUT_LENGTH` rule is uncalibrated and unplumbed.

`BASH_MAX_OUTPUT_LENGTH` appears nowhere in `src`. §3 leaves open: where the variable is read (`STOP_TRANSPORTS` is static, [native-listening.ts](src/cli/native-listening.ts:37); per-invocation env adjustment needs a stated home), why the factor is 0.8, whether the variable is bytes or characters and what the interface does at the limit (truncate vs preview), which hold reason/message applies when the floor 4,096 refuses a reference offer, and the assumption that the hook's environment equals the reading session's.

Required change: specify the read site, justify or measure the 0.8 margin including the `nextOffset` trailer line ([dispatch.ts](src/cli/dispatch.ts:330)), and define the below-floor hold (reason, message, no-copy discipline).

### V2-4. Blocking. The `stopped`+`held` result has no consumer.

§5 returns `{ kind: "stopped", reason: "expired", held }`, but `NativeListenerResult`'s `stopped` variant carries no `held` field ([native-listener.ts](src/modes/native-listener.ts:52)), and the Claude dispatch branch maps `notice` to `systemMessage` while `stopped` is silent ([dispatch.ts](src/cli/dispatch.ts:219)). `ClaudeHookResult` includes `NativeListenerResult` ([hooks/claude.ts](src/cli/hooks/claude.ts:144)), so the shape typechecks only after the variant change, and still prints nothing without a dispatch mapping. Threading through `disable()`'s null path ([native-listener.ts](src/modes/native-listener.ts:283)) is also unspecified.

Required change: define the type change plus the dispatch mapping (stopped-with-held to `systemMessage`, or return `notice`), with tests: hold-then-expiry emits, offered/interrupted emit nothing.

### V2-5. Major. "Does not widen that window" is misleading; abandonment has no recovery story.

Reference delivery converts inputs that today hold (retryable, cancellable pre-start) into `sending`/`received` offers that fence the record via `hasUnresolvedOffer` ([connection.ts](src/protocol/connection.ts:252)), while `nativeInputCancellationCheck` still refuses cancel for started inputs ([connection.ts](src/protocol/connection.ts:257)) and `listener-disabled` clears no offers ([connection.ts](src/protocol/connection.ts:1401)). A session that receipts then abandons the reads (Escape, cap reached, user moves on) strands the record exactly as R3 described, now on a path that requires 4+ reads to close. The per-offer window mechanics are unchanged; the exposure is not.

Required change: either qualify the claim or add a recovery path (e.g. cancel-input for reference offers, or expiry/withdraw of stranded offers with copy cleanup), plus a test: receipt, abandon, recover, re-deliver.

### V2-6. Minor. Respond-time outcome parsing is unspecified.

§4 gates on "outcome kind is answer or question", but `control.outcome` arrives as `unknown` ([conversation-host.ts](src/store/conversation-host.ts:1368)). State the validation (malformed outcome to `invalid-connection` before any filesystem access) so the gate cannot run on unvalidated input.

### V2-7. Minor. §4 re-describes the lookup instead of citing it.

`nativeContextReadIssue` ([context-offer.ts](src/store/context-offer.ts:360)) already implements the prefix scan, exactly-one rule, privacy/uid checks, and post-header size comparison. §4 should cite it as the implementation and add only what it lacks (canonicalization/TOCTOU posture; it stats via non-canonical paths). Acceptable as-is only because §2 declares progress is not a security boundary.

### V2-8. Minor. Progress-write wording drifts from `atomicSidecar`.

§2 says `progress.json.<random>` with mode 0600 and flag `wx`; the code writes `<path>.<uuid>.part` with `O_CREAT|O_EXCL|O_NOFOLLOW`, fsync, rename, and directory sync ([atomic-file.ts](src/store/atomic-file.ts:20)). Also unmentioned: a failed progress write only warns ([context-offer.ts](src/store/context-offer.ts:348)), leaving progress behind and forcing reread. Align the wording; no behavior issue.

### V2-9. Minor. Ambiguous whether `readOfferedContext` gains a uid check.

§2: "The reader also requires the copy directory and `context.txt` to be owned by the current uid, which the current read path does not check." The current read path indeed checks no uid ([context-offer.ts](src/store/context-offer.ts:247)). If this means changing `readOfferedContext`, it alters the managed/headless path too; if it means only the respond-time lookup (which already checks uid, [context-offer.ts](src/store/context-offer.ts:380)), say so.

Required change: state explicitly that `readOfferedContext` is unchanged and ownership is enforced only at respond time.

### V2-10. Minor. `delivery.bytes` validation bounds unspecified.

§1 says the parser rejects a malformed `delivery`. State the bounds (safe integer, lower bound, any upper bound) so "exact shape" is implementable and the downgrade story in §1 covers a new-build log with absurd `bytes` replayed anywhere.

## 3. Factual-claim check

Verified true against code: 19,900/7,900 caps ([native-listening.ts](src/cli/native-listening.ts:29)); preparation hold order and messages ([native-preparation.ts](src/modes/native-preparation.ts:44)); field-by-field `offer-started` parsing that drops unknown fields ([connection.ts](src/protocol/connection.ts:881)); lazy reaper retaining unknown ownership ([context-offer.ts](src/store/context-offer.ts:76)); copy removal on accepted outcome ([conversation-host.ts](src/store/conversation-host.ts:1073)); held-then-continue listener loop ([native-listener.ts](src/modes/native-listener.ts:255)); silent expiry today (dispatch ignores `stopped`, [dispatch.ts](src/cli/dispatch.ts:219)); block-cap check preceding the listen ([hooks/claude.ts](src/cli/hooks/claude.ts:292)); block cap default 8 ([hooks/claude.ts](src/cli/hooks/claude.ts:44)); 20,030-character probe comment ([native-listening.ts](src/cli/native-listening.ts:32)); `lucid context <dir> [--offset] [--bytes]` command shape ([mapping.ts](src/cli/mapping.ts:244)); refused `receipt`/`respond` committing through the PostToolUse proposal path ([hooks/claude.ts](src/cli/hooks/claude.ts:186)); `readOfferedContext` performing no uid check ([context-offer.ts](src/store/context-offer.ts:247)); no `BASH_MAX_OUTPUT_LENGTH`, `contextSlice`, `delivery`, or `contiguous` handling outside the cited new helpers. The "feedback text alone is too large" hold message slightly overstates (fixed reference overhead also contributes), but the message is reasonable.

## Verdict

**Revise.** R1-R5, R10-R12, and R14 are resolved; R6-R9 and R13 are partly resolved. V2-1 (spec contradicts the landed reader; its acceptance test would fail) and V2-4 (result shape with no consumer) are blocking. V2-5 needs an abandonment recovery story or an honest scope qualification, V2-3 needs the env-variable calibration, and V2-6 through V2-10 are small specification tightenings.