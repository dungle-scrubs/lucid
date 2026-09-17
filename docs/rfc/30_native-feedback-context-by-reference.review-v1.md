# Review: RFC 30 (native feedback context by reference)

Scope: read-only review of `docs/rfc/30_native-feedback-context-by-reference.rfc.md` against the code cited. No files changed.

## Summary

The direction is sound: keep inline delivery when it fits, and move the complete context to a private offered copy (the mechanism managed/headless execution already uses) when it does not. But the draft has load-bearing gaps: a false compatibility claim about the new `delivery` field, no home for the receipt filesystem gate that preserves replay determinism, and stuck-offer states where one unread reference offer permanently fences the conversation. The progress gate also needs honest scoping: it proves bytes were emitted through tool output, not that the model used them, and in Claude Code a subagent can do all the reading. Verdict at the end: **revise**.

## Findings

### R1. Blocking. The "old builds refuse the new field" claim is false, and that breaks the compatibility story.

The RFC (section 1) says: "Earlier Lucid builds refuse logs containing the field. That is the existing rule for any fact they do not parse."

The parser does not work that way for known fact kinds. `parseConnectionFact` for `offer-started` builds the offer field-by-field and ignores unknown fields ([src/protocol/connection.ts](/Users/kevin/dev/lucid/src/protocol/connection.ts):881-911), and `NativeOffer` has no `delivery` member (:205-213). An old build would therefore parse a new `offer-started` successfully and silently drop `delivery`. The reducer then stores the offer without it (:1456-1481) and later accepts `receipt-confirmed` with no read gate (:1482-1511). Refusal on unknown input applies to unknown fact *kinds* (`return null` → `invalid-connection`, :912-913, :973-975), not to extra fields on known kinds.

Required change: specify the real compatibility mechanism. Either bump the connection `payloadVersion` (currently 2, per RFC 26 durable-fence section) for facts carrying `delivery`, or make the new parser reject an `offer-started` whose `delivery` is malformed/unknown while explicitly documenting that pre-patch builds silently weaken the guarantee on upgraded records. Add a cross-version test: new log replayed by the old parser must not be accepted as a fully-gated log. At minimum, delete the false sentence and replace it with the actual drop-vs-refuse behavior.

### R2. Blocking. The receipt read-gate has no specified home, and the current receipt path performs no I/O.

The RFC (section 4) says "The check runs in the live writer, not in replay, like the other native verification." But `controlConnection` for `receipt` constructs a `receipt-confirmed` fact with zero filesystem access ([src/store/conversation-host.ts](/Users/kevin/dev/lucid/src/store/conversation-host.ts):1358-1387), and `runConnectionControl` does no I/O gating either ([src/cli/connection-control.ts](/Users/kevin/dev/lucid/src/cli/connection-control.ts):72-114). The existing live-only precedent is the `preparationIssue` check for `offer-started`/`input-held` inside `evaluateConnection` (:996-1018), which runs before `reduceConnection`. There is no equivalent hook for receipt.

Required change: specify the gate as a live pre-check in the writer path (mirroring `preparationIssue`), keeping the durable `receipt-confirmed` fact byte-identical so replay of an already-recorded receipt still applies without the progress file. State exactly: parse `delivery` in `parseConnectionFact`; carry it in `NativeOffer`/reducer state; live-gate receipt in `evaluateConnection` by reading `progress.json`; replay path untouched. Add tests for live-refuse-then-replay-accept of the same recorded receipt.

### R3. Blocking. One unread reference offer permanently fences the conversation with no exit.

Once `offer-started` commits, `hasUnresolvedOffer` is true ([src/protocol/connection.ts](/Users/kevin/dev/lucid/src/protocol/connection.ts):252-254), so `hasUnsettledNativeWork` holds (:282-294) and `nativeInputCandidates` returns empty ([src/store/managed-readiness.ts](/Users/kevin/dev/lucid/src/store/managed-readiness.ts):90). Meanwhile `nativeInputCancellationCheck` refuses cancellation for any started input (:257-280), and copy cleanup happens only on `offer-outcome` ([src/store/conversation-host.ts](/Users/kevin/dev/lucid/src/store/conversation-host.ts):1062-1074). The RFC's `context-unavailable` outcome is "the offer stays `sending`, exactly as it would with a receipt that never arrives" (section 4). Combined, a session that never finishes the reads, or a copy that is deleted/resized, bricks all future native delivery for that record.

Required change: add a terminal path for a `sending` reference offer that can never complete: either allow `cancel-input` before receipt for reference offers (clearing the offer, deleting the copy scope, and re-holding the input), or expire/withdraw `sending` offers on `listener-disabled` with `owner-lost`/explicit cancel, with copy cleanup on the same path that `closeNativeContextOffers` uses. Test: reference offer → delete copy → cancel → re-offer or re-hold, and delivery unblocked.

### R4. Major. Copy loss after owner exit has the same bricking shape, and reaping is lazier than the RFC implies.

The RFC says "The copy is removed when the response is accepted or its owner process exits, as today." In fact removal on response acceptance exists (:1073-1074, plus the `closeFinishedNativeContextOffers` recovery path in [src/store/context-offer.ts](/Users/kevin/dev/lucid/src/store/context-offer.ts):118-127), but owner-exit reaping happens only lazily at the next `offerContext` call (:136-141 → `reapContextOffers` :76-81), and unknown ownership is explicitly retained (:76-81). If the native owner exits between offer and receipt, the next preparation reaps the copy and every later receipt hits `context-unavailable` → stays `sending` → R3 brick.

Required change: define recovery for this case (re-materialize the copy from the durable log on demand and reset progress, or convert the stranded `sending` offer back to held plus a re-offerable input) and correct the "as today" sentence to describe the lazy reaping and the retained-unknown-ownership cases.

### R5. Major. The progress gate proves emission, not use, and the reads are unattributed.

The RFC is candid that "Progress means the bytes were emitted into the session's command output in order. It does not prove the model used them" (section 2), but the design still presents receipt gating as completing delivery. Three facts widen this: (a) Claude Code runs a subagent's Bash with the parent's session ID/process and Lucid commands commit via the PostToolUse proposal path ([docs/native-claude.md](/Users/kevin/dev/lucid/docs/native-claude.md):36-53), so a subagent can perform every `lucid context` read while the parent receipts; (b) `lucid context` performs no caller authentication ([src/cli/dispatch.ts](/Users/kevin/dev/lucid/src/cli/dispatch.ts):330-340); (c) the response body is never checked against the context, and the feedback text itself stays inline in the reference payload (RFC section 1), so the model can answer from the inline text after mechanically paging. The gate is therefore a cost barrier, not a comprehension proof.

Required change: scope the guarantee honestly ("all bytes were emitted through this session's tool outputs in order; use is not verified"), decide and document the subagent-reads question (either accept parent-attributed reads as satisfying progress, or wrap `lucid context` reads for Claude in the proposal/commit path so reads are parent-attributed like receipt/respond in [src/cli/hooks/claude.ts](/Users/kevin/dev/lucid/src/cli/hooks/claude.ts):186-246), and add a negative test: subagent-performed reads plus parent receipt, asserting the specified outcome.

### R6. Major. Private-copy and progress-file checks are underspecified, and the read path checks less than the RFC assumes.

`readOfferedContext` validates the directory as private and ordinary, pins the file with `O_NOFOLLOW`, and checks `nlink`, file mode, `realpath`, and dev/ino ([src/store/context-offer.ts](/Users/kevin/dev/lucid/src/store/context-offer.ts):247-281), but it does **not** check uid/owner binding on the read path (uid appears only in sweep paths, :62, and proposal storage elsewhere). The RFC's "same private-file checks as `context.txt`" for `progress.json` therefore needs a real list, and "locates the copy by its owner and offer scope" (section 4) needs an algorithm (recompute `contextScope` per :91-96 and scan, or persist the path; each has symlink/rebind implications).

Required change: specify for `progress.json` the full check set (private dir, `O_NOFOLLOW`, uid equals the offer owner, `nlink == 1`, dev/ino stability, atomic write-then-rename, mode 0600), the receipt lookup algorithm including TOCTOU handling, and the exact mapping (unreadable/invalid progress → 0 per RFC, vs missing/resized/unowned copy → `context-unavailable`). Add tests for corrupt progress, swapped progress file, and resized `context.txt`.

### R7. Minor. Interleaved/concurrent readers and receipt retry need one paragraph.

With a single monotonic `contiguous = max(contiguous, nextOffset)`, out-of-order concurrent reads are refused at read time, which is safe, but two readers paging simultaneously plus a receipt attempt mid-flight produce `context-unread` followed by retry. That retry loop is fine (refused receipts are re-runnable proposals in [src/cli/hooks/claude.ts](/Users/kevin/dev/lucid/src/cli/hooks/claude.ts):175-182, single-use nonces in [src/store/claude-proposals.ts](/Users/kevin/dev/lucid/src/store/claude-proposals.ts):102-151), yet the RFC never states it.

Required change: state that `context-unread` is retryable without re-preparation, that reads are idempotent (rereads allowed at or below `contiguous`), and that no new offer is needed after a refused receipt.

### R8. Major. The Claude slice probe is load-bearing and unrun; the RFC must keep the gate closed until it passes and account for the proposal round trip.

`STOP_TRANSPORTS` caps Claude at 19,900 encoded bytes with `JSON.stringify({decision, reason})` encoding ([src/cli/native-listening.ts](/Users/kevin/dev/lucid/src/cli/native-listening.ts):31-43), and the RFC correctly keeps `contextSlice` unset until the isolated probe passes. But the acceptance script then assumes multi-`Bash`-call paging inside one Stop continuation plus a proposal-mediated receipt (Claude `receipt`/`respond` go through `proposeClaudeOperation` → `pending`, committed later by PostToolUse; [src/cli/dispatch.ts](/Users/kevin/dev/lucid/src/cli/dispatch.ts):254-302, [src/cli/claude-commands.ts](/Users/kevin/dev/lucid/src/cli/claude-commands.ts):30-31). Proposal TTL is 10 minutes ([src/store/claude-proposals.ts](/Users/kevin/dev/lucid/src/store/claude-proposals.ts):42-43).

Required change: require the slice value to include margin for the trailing `nextOffset` line **and** multi-line content (the failure mode the RFC names), keep reference offers disabled while `contextSlice` is unset (already stated; add the corresponding `STOP_TRANSPORTS` diff and test), and extend the native acceptance script to cover the refused-then-accepted receipt round trip through the PostToolUse commit, including expiry behavior when paging exceeds the Stop continuation's practical tool-call budget.

### R9. Major. Section 5 (hold notice as `systemMessage`) is underdesigned.

Today a held Stop result goes to stderr (`reason: message`, [src/cli/dispatch.ts](/Users/kevin/dev/lucid/src/cli/dispatch.ts):228-231) while `systemMessage` is produced only for `notice` (:227); the listener's expiry path returns `disable(reason) ?? {stopped}` with no hold text ([src/modes/native-listener.ts](/Users/kevin/dev/lucid/src/modes/native-listener.ts):283-284). To implement section 5 the RFC must define: which hold (the loop can record several holds across inputs, :255-270), filtered to the current participation; precedence against the block-cap `notice` ([src/cli/hooks/claude.ts](/Users/kevin/dev/lucid/src/cli/hooks/claude.ts):292-311); no notice when an offer was delivered; and the new `runClaudeHook` result variant mapping to `systemMessage`. Note the loop already skips freshly-held inputs via the prerequisite filter ([src/store/managed-readiness.ts](/Users/kevin/dev/lucid/src/store/managed-readiness.ts):93-108), so "waits for other feedback" is implementable, but the notice must name the specific held input(s).

Required change: specify the result type, the participation filter, precedence rules, and the interrupt case (a `UserPromptSubmit`-adjacent abort injecting a `systemMessage` into a superseded turn needs explicit justification or exclusion). Add tests: hold-then-expiry emits the notice; offer-then-expiry does not; block-cap precedence.

### R10. Major. Order the reference path after the existing hold checks and pin the copy helper.

The RFC's out-of-scope rule (attachments stay held) depends on check ordering in `prepareNativeFeedback`: transport-verified (:44-50), attachment/file-capability hold (:88-94), comparison hold (:109-114), then the `maxBytes` hold (:193-201). A reference path inserted after the `maxBytes` check must preserve all three earlier holds and their `discard()` discipline, and must use plain `offerContext` (not `offerProjectedContext`, which copies attachment bytes per [src/store/context-offer.ts](/Users/kevin/dev/lucid/src/store/context-offer.ts):183-227) since attachments stay held.

Required change: state the exact order (files → comparison → inline-size → reference-or-hold), that the reference copy text equals the already-rendered inline bytes minus the offer block (define whether the attachment-manifest branch can ever appear), and add tests: oversized-with-attachments stays held with the existing message; oversized comparison-hold stays held and never writes a copy.

### R11. Minor. Define the `bytes` domain.

`delivery.bytes` ("copy size") is ambiguous across the `LUCID_CONTEXT_V1` header (:26), post-header offsets, and trailing UTF-8 trim (:279-296). Progress `contiguous` must be in the same domain as the receipt comparison.

Required change: define `bytes` as the post-header context-text byte length, `contiguous` in the same domain, receipt condition `contiguous >= delivery.bytes`, and `done` equivalence with `readOfferedContext`'s `done` flag.

### R12. Minor. New refusal codes are wire vocabulary and collide by name.

`REFUSAL_ISSUES` ([src/protocol/frames.ts](/Users/kevin/dev/lucid/src/protocol/frames.ts):84-128) contains neither `context-unread` nor `context-unavailable`, while `NATIVE_PREPARATION_REASONS` already contains `context-unavailable` ([src/protocol/connection.ts](/Users/kevin/dev/lucid/src/protocol/connection.ts):178-186) with a different meaning (preparation hold vs receipt refusal). `refusalMessage` has no branches for the new codes and falls through to generic ([src/cli/connection-control.ts](/Users/kevin/dev/lucid/src/cli/connection-control.ts):50-69).

Required change: add both codes to `REFUSAL_ISSUES` with message mappings and UI/docs updates, and either rename the receipt code (e.g. `receipt-context-unread`, `receipt-context-missing`) or justify the reuse with a mapping table showing the two vocabularies stay distinct.

### R13. Missing acceptance coverage.

Beyond the RFC's list, required tests: logs without `delivery` replay unchanged (stated) **plus** new-log-on-old-parser behavior per R1; inline receipt unchanged (stated) **plus** reference receipt refused before / accepted after / refused on missing-or-resized copy (stated) **plus** cancel/re-offer recovery per R3; gap-refused, reread-allowed, corrupt-progress-counts-as-zero; oversized-feedback-text hold message distinct from oversized-context hold; Codex path unchanged (no `contextSlice`, no `delivery`, existing hold message); `systemMessage` notice only for own-participation holds.

### R14. Simpler alternative the RFC should justify against.

The draft rejects previews, digest receipts, and file-tool reads, but not the closest simpler design: sequential per-slice offers reusing the existing offer/receipt machinery (each slice inline, each receipt durable, no new progress file or filesystem gate in the writer). Another is routing oversized native inputs to the managed/headless path that already reads offered copies (`offerProjectedContext` + `lucid context` reference in [src/modes/managed-preparation.ts](/Users/kevin/dev/lucid/src/modes/managed-preparation.ts):330-341, contract in [docs/drivers.md](/Users/kevin/dev/lucid/docs/drivers.md):237-248).

Required change: one paragraph explaining why a single reference offer plus a new progress file beats per-slice offers (round-trip cost vs new trusted state), or adopt per-slice offers and delete sections 2 and 4.

## Verdict

**Revise.** The shape is right, but R1 (false compatibility claim with silent-downgrade consequence), R2 (no specified home for the receipt gate), and R3-R4 (unexitable `sending` states that fence all future delivery) are blocking. R5-R10 need specified behavior and tests before implementation. I recommend revising the RFC to fix R1-R4 first, then filling R5-R12, then proceeding to code.
