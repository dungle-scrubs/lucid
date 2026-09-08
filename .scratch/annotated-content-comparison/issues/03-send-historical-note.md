# Send a historical note and revise current content

Status: resolved
Blocked by: 01, 02

## What to build

A person selects earlier or current content, writes a small note beneath it, and sends it once. The note enters the existing conversation with its historical source. At delivery, the agent receives the complete current document and produces a new immutable version without rolling back unrelated changes.

Complete RFC 14 revision 4 across browser entry, durable input, supported delivery adapters, transcript, and revision. Keep provenance, acceptance, and delivery together so no usable intermediate comparison action can target an old version by mistake. Reuse ticket 01's recovery and ticket 02's comparison.

## Acceptance criteria

- [x] Selecting words or a passage on either side opens one compact note box beneath that source, with version, quote, note text, Send note, and Cancel. It contains no transcript or second chat composer. Changing selection with a nonempty draft requires resolution; reading elsewhere preserves it.
- [x] Send follows selected harness, model, and effort under existing driver rules and queues at the next turn boundary when busy. It submits exactly one note from one source version, with no Resume button, second chat send, or mixing or flushing of ordinary notes.
- [x] Each fresh Send checks for a nonempty ordinary queue in this page with the same conversation, artifact, and source version before creating an identity. Resolve that queue at its original version or preserve both drafts. Unrelated queues remain unchanged; unresolved-request reconciliation is exempt.
- [x] Batch version stays the immutable source version. Comparison metadata distinguishes earlier, reviewed, and source versions and hashes. Fresh admission rejects incomplete or invalid provenance, mixed sources, multiple notes, and missing or ambiguous source addresses with E-COMP-03.
- [x] Source selectors and reader element IDs address saved content and agree with source inspection after reload. Quotes preserve original text and significant preformatted whitespace within existing bounds, with visible truncation. Application context stays separate from the person's note and treats quoted content as evidence.
- [x] Every path admitting comparison metadata atomically checks a fresh request's reviewed version and hash against refreshed record state inside the append transaction. Stale requests append nothing. Accepted identity reconciliation precedes that guard and reuses ticket 01's original request.
- [x] Arrival of a new version preserves pair and draft until explicit Review latest, which changes only the reviewed base. If a v17 source leaves a refreshed v12/v18 pair, preserve its excerpt and editor above passage rows with the original version label. Explicit review restores editor focus and selection; automatic arrival does not steal focus.
- [x] A stale fresh Send stays disabled until review. Cancel removes only the draft and retained excerpt. Source changes, closing, and inspection honor pending-work guards without silent retargeting.
- [x] Durable acceptance closes the editor and creates one transcript note with quote and version. Markers use accepted input identity and note index zero, with separate navigation for multiple notes. Pending, uncertain, held, working, and failed states reflect actual lifecycle events.
- [x] Reload and replay reconstruct accepted notes and links. A source absent from the pair stays an intentional historical reference with inspection, not an ordinary orphan or guessed anchor. Stored unusable comparison extensions preserve valid legacy text and evidence while disabling unavailable navigation; unknown fields remain tolerated.
- [x] At actual dispatch, provide the complete latest document even when agent-authored or previously known. The dispatch version is at least the reviewed version and is the sole emission target. Source and reviewed versions are historical evidence; current human saves are included.
- [x] Headless-session, headless-turn, and interactive hooks each satisfy the contract at their delivery boundary. Hooks include artifact emission teaching. Unsupported or observe-only delivery holds the note with its limitation, never sends through a legacy preamble or triggers managed takeover.
- [x] Preparation failure records E-COMP-07 with input, artifact, and failed-head identity and ensures durable queued disposition. It never records applied or rejected, dispatches stale or truncated context, drops the note, or claims a completed turn.
- [x] Held notes explain the observed cause and applicable recovery: current document unavailable, session unable to receive comparison notes, or document too large. Readable content does not mask capability failure. A changed failure updates the explanation while earlier errors remain history.
- [x] Skip holds while eligible inputs run in original acceptance order. Recovery restores a held input's place without interrupting a turn; input/turn association follows its original identity. All-held queues stay idle; existing admission and in-flight limits keep their meaning.
- [x] Within one participation, only a strictly newer head permits another bounded preparation attempt. Explicit new attachment permits one attempt, including on the same repaired version. Failure updates the failed head and holds again. Replays, heartbeats, later input without a newer head, and timers do not retry; holds add no automatic detach, reopen, takeover, or Retry/Resume control.
- [x] Successful preparation records applied only at actual delivery and supersedes the held explanation. Later delivery failure follows the existing protocol. Accepted revisions append immutable versions; stale emission follows existing refusal and recovery without reverse patches or silent rebasing.
- [x] For each adapter, deterministic tests prove a held note, later eligible ordinary input, releasing version, recovery, reattachment, identity, ordering, and bounded attempts. Include every hold cause, changed causes, readable content on unsupported delivery, and transport limits without truncation.
- [x] End-to-end deterministic checks cover new versions before Send, during queueing, and during generation; source retention after refresh; conflicting and unrelated queues; response recovery; attachments; legacy batches; replay; and driver changes. Add no full-document copies to every note or second durable store.
- [x] Verify pointer and keyboard entry, retained-source placement, source-to-transcript links, and conversation placement at 390, 768, and 1440 pixels in both themes. All repository checks pass without waived gates; live-harness confirmation is supplementary.
- [x] Update changed artifact, source, driver, and design contracts with the complete path. Prototype assets stay separate; completed proposals are retired only after delivery under the documentation lifecycle.

## Parent

[RFC 14, revision 4: Annotated content comparison](../spec.md)

## Delivery evidence

Implemented in the working tree. `test/modes/comparison-delivery.test.ts` covers atomic admission, two writers, source-frame admission, accepted-ID reconciliation, retained sources, known and unknown extensions, each shared preparation failure, bounded retries, session/turn/hooks delivery, later ordinary work, recovery, explicit reattachment, ordering, current human saves, fresh resume fallback, and stale emission during generation. Recovery and HTTP tests cover lost responses, restart/token renewal, explicit retry, conflicts, storage failure, and unchanged request identity. Comparison-view tests retain multiple source selections and attachment evidence after refusal. `test/server/transcript-runtime.test.tsx` prevents an asynchronous save marker from hiding an accepted note on reload. Browser checks confirmed note entry, one accepted transcript note, exact-source marker navigation, reload replay, and uncertain-send locking. Native headless-browser reload while a pending-send beforeunload guard is active stalled automation; the real-HTTP controller tests prove same-tab unresolved recovery. A copied pending request was also loaded through a real browser reload: mounting made no send, Retry returned the original receipt, the transcript retained two comparison notes, and recovery storage cleared. No live harness was used.

Current contracts: docs/artifacts.md, docs/drivers.md, docs/skill-chat-substrate.md, docs/design.md, and docs/design-brief.md. Implementation has not been committed or pushed. Retire RFC 14 and its reviews with the implementation landing so the revised proposal remains recoverable from Git.

Final validation: `bun run check` passes (1,083 tests, 5,428 assertions), `bun run build` passes, and `git diff --check` is clean. Temporary verification processes were stopped.
