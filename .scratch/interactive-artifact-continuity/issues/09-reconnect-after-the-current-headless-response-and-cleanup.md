# 09: Reconnect after the current headless response and cleanup

Status: claimed
Blocked by: 02, 07, 08

## What to build

The terminal reconnect command reserves return, waits for the current response to settle, and launches the exact native session once.

## Acceptance criteria

- [ ] The reservation fences managed and manual executor entrants; only the matching reconnect request or verified child can cross its admission gap.
- [ ] Current response and owned cleanup finish before native history loading, including question and failure outcomes.
- [ ] Already-live owners get existing-session listening instructions. Duplicate requests join or report the same pending request.
- [ ] Cancellation withdraws only a pre-launch wait; parent death, missing child provenance and lost control remain held unless no creation is proven.
- [ ] Claude and Pi instructions explain that direct native resume bypasses this protected workflow; observed conflicts hold subsequent delivery.
- [ ] Multiprocess race and crash tests prove launch ordering and cleanup-before-release.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Implementation seams

The accepted RFC holds scope: one person returns to the native session that authored an artifact. Start with durable reconnect request and withdrawal facts in the shared connection reducer and host. The current response and its owned cleanup continue; candidate selection, preparation, final dispatch and all executor admission paths observe the reservation. Test actual record replay, presence locks, duplicate requests, cancellation and preparation-to-dispatch races before adding terminal launch. The HCN seam then consumes its existing strict interactive operation and records correlated start/refusal/cleanup evidence. CLI and browser controls follow only after their underlying operations are supported. These are machine-made implementation steps within the approved ticket and RFC.

## Reservation checkpoint

One durable request now holds new native work without taking an executor lease. Explicit cancellation names the pre-launch wait, preserves feedback and current work, and cannot cancel a newer request through historical replay. Duplicate requests read the existing result without renewed native admission. New requests still refuse alive or unknown native ownership and serialize through registration and record append ordering. This uses the existing record-control authority boundary; automatic requester-loss withdrawal remains a separate evidence operation.

Tests cover record reopen/replay, actual presence locks, request arrival during raw lease acquisition, a request after preparation with zero HCN creation, and a pending approval that receives one saved decision and finishes response plus cleanup while reconnect remains reserved. The idle status reads Waiting to reconnect. Four Muse review axes and scoped fixes pass 1,621 tests and build. Evidence and review dispositions are under ignored native-reconnect-* artifacts.

HCN interactive consumption, reconnect launch and matching-child admission, requester-loss reconciliation, public controls, multiprocess full handoff and native acceptance remain pending. Runtime stays fenced. The launch phase must leave requested state before invocation and reject cancellation after that transition.

## Launch admission slice

Machine-made seams under the accepted RFC: reconnect uses the host's shared executor acquisition, then persists intent, then revalidates under registration and record ordering through synchronous invocation. The acquired lease is private authority for that one request. Intent consumes the cancellable wait before HCN can run. The next tests attach at the host with actual record replay and presence handles: persist intent before the callback, reject a cancelled/replaced request at acquisition, reject lease loss or a returning native owner at dispatch, and consume a throwing invocation once. Started child provenance and matching-listener transfer follow this admission slice before exposing the command.

Requester-loss reconciliation uses the same append transaction to corroborate the exact requester's exit and prove that the request remains in its pre-intent phase. Its durable withdrawal reason stays distinct from explicit cancellation. Unknown or live requesters hold the reservation; any persisted intent blocks this reconciliation even after parent death. Tests cover those cases and historical readback without repeating an owner probe. This is the existing RFC requester-loss requirement, with no expiry or new user action.

## Launch admission checkpoint

The shared host now admits only the matching requester, records a stable launch intent before invocation, and keeps registration plus append ordering through its one synchronous dispatch. Intent blocks cancellation. Lease loss, changed owners, and a throwing invocation retain that intent without another spawn. A host with a live admitted lease refuses another acquisition before the lock callback. The caller owns release after cleanup or the specified started-provenance handoff; closing the host does not release a process owner's lease.

Requester-loss reconciliation records requester-exited separately from explicit cancellation. It needs a fresh exact-process exit result and requested phase under append ordering. Historical readback repeats neither probing nor withdrawal. Actual disposable process tests confirm that kernel lock release after requester death does not erase persisted intent. The initial process-test cached read was corrected to the existing fresh durable view; production behavior and assertions were retained.

Four Muse review axes and scoped fixes pass 1,658 tests and build. Review/evidence is under ignored reconnect-launch-admission-* and reconnect-launch-review-* artifacts. Started/refused/closed consumption, matching-listener transfer, public controls and native acceptance remain pending. This checkpoint does not enable the bound runtime.

## Started child provenance slice

Machine-made seam under RFC 26: the host records the exact child owner from the correlated HCN started record only for its consumed private launch invocation while it still holds the admitted lease. Durable readback does not repeat creation or renew authority. The command may release that lease only after this write; the reservation continues to hold until a matching verified listener is admitted. Tests first reject forged/pre-dispatch provenance, then preserve the correlated owner across replay and lease release. Matching listener admission and HCN terminal completion follow this fact before public activation.

## Child transfer checkpoint

The host records the full normalized HCN creation tuple after the private invocation is consumed: launch ID, native session ID, original folder, interface and process owner. It validates that tuple against the immutable binding and retains it for replay. The source adapter opens HCN with that exact target, routes synchronous invocation through final admission, and releases the command's lease only after the creation write. Only the verified matching child may then acquire presence. Its listener-enabled write atomically fulfills the reservation and preserves the original launch, owner and participation evidence.

The bounded native listener now follows that same admission path and offers saved feedback without inferring receipt. Status reports listener waiting, unknown child or prior owner, and conflicts. Fulfilled child ownership remains in the existing participation history; the new owner scan reads only the active reservation. Real disposable-process checks show requester death cannot clear a reservation while its recorded child remains alive. Source tests retain intent and feedback for wrong HCN targets and throwing invocation.

Four Muse review axes and scoped fixes pass 1,667 tests and build. Spec review identified missing reported target fields; those were added with the owned source-to-host path and rejection tests. Complete dispositions and source evidence are under ignored reconnect-child-* artifacts. The source currently returns its terminal operation result; durable refused/closed/uncertain settlement, hook selection, public commands/controls and native acceptance remain pending. Runtime remains fenced.

## Terminal outcome slice

Machine-made seam under RFC 26: the owned source appends the normalized terminal result only after the control stream drains and the HCN wrapper exits. The host checks the private launch, exact requester and operation-specific pre-start evidence; raw control writes cannot claim owned completion. The reducer retains a terminal result once, separately from started provenance and listener fulfillment. Missing/contradictory control remains uncertain, including after listener fulfillment. An intended reservation is not silently withdrawn by parent exit or a terminal result when no listener established identity. The first test extends the owned HCN source oracle through durable cleanup-result replay, then refusal, uncertainty and late settlement after listener fulfillment follow.

## Terminal outcome checkpoint

The owned source now saves closed, refused or uncertain completion after control drain and wrapper exit. It retains the original request and started provenance after listener fulfillment. Raw control writes, changed results and contradictory creation evidence are refused; late uncertainty fences further execution. Final-admission cancellation with zero HCN invocation retains its specific no-dispatch evidence. Status distinguishes refusal, verified closure before listening, and uncertain completion. Transport and durable replay share the same closed HCN refusal-reason validator.

Four Muse review axes are complete. The protocol import and refusal-parser findings were fixed; drain/exit ordering and uncertainty fences remain required. Evidence and exact dispositions are under ignored reconnect-outcome-* artifacts. Public reconnect waiting, hook selection, recovery controls and native acceptance remain pending; this checkpoint does not enable the bound runtime.

## Returned child selection seam

Machine-made continuation of the accepted reconnect seam: the existing Codex resume-listen command may select the reserved conversation only for its recorded, verified started child after the requester releases presence. Selection still grants no listener readiness and does not fulfill reconnect. Other records, owners, unresolved execution, and terminal reconnect results remain fenced. This holds product scope: the same native author receives the existing artifact's saved feedback. Tests use the public command selection, registration authority, durable host and kernel presence seams, beginning with exact-child selection and followed by refusal controls.

The existing Codex resume-listen selection now admits the exact recorded child only for its reserved conversation, after presence release. Selection neither fulfills reconnect nor claims listening. Refusal controls retain the prior selection before creation, while presence is held, when another same-history conversation is selected, and after terminal uncertainty. All four Muse reviews report no findings. Full check passes 1,673 tests and build; evidence is under ignored reconnect-selection-* artifacts. Automatic hook selection and native acceptance remain pending.
