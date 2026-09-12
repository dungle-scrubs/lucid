# 08: Resume departed authors headlessly with the same native ID

Status: claimed
Blocked by: 01, 02

## What to build

New saved feedback automatically resumes the bound native conversation only after every interactive owner is confirmed gone.

## Acceptance criteria

- [ ] Alive owners retain the resume-listening instruction; unknown owners hold feedback with the specific reason.
- [ ] All executor entrants recheck durable connection admission around the existing presence lock.
- [ ] The agreed native-ID notice is appended once after final admission and before process creation; losing contenders emit none.
- [ ] Strict same-harness and same-folder continuation ignores incompatible saved preferences, marks managed launch role and preserves the original input.
- [ ] Pre-start refusal can retry the same session after repair; started or uncertain work cannot be automatically replayed.

## Implementation checkpoint

The shared ConversationHost.acquireExecutor operation checks the current record, acquires the existing presence lock, then rechecks under the append lock before returning an executor lease. Manual headless starts and managed workers share the runtime caller; the internal native listener holds registration authority across admission and its enable write. Refusal or read failure releases the raw lock. Replaying an old listener-enable action does not renew authority. Real-record tests cover binding and terminal appearance during acquisition, native owner loss/unknown, and readiness only after enable. Four Muse reviews found no blocking admission defect; full check passes 1,521 tests and build. Bound headless continuation remains fenced. Durable launch facts, same-ID invocation, reconnect and native interface acceptance remain pending, so the full admission criterion stays unchecked.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Continuation implementation seams

Tickets 01-03 now establish shared publication/delivery and the Codex CLI native lane. Continue this ticket independently of the blocked Muse adapter. Scope holds: saved feedback continues the already bound native conversation after confirmed departure.

Use the existing shared executor admission, managed preparation/dispatch and HCN runner seams. Add durable launch intent and settlement to connection state; the intent itself projects the agreed transcript notice. The existing execution attempt remains the response outcome owner. Reconnect and uncertain launch state must remain admission fences, even before the reconnect command is exposed.

One native session may be bound to more than one Lucid record. Admission must therefore serialize the short selection/intent transaction under the existing registration lock and inspect all records for that exact harness/native ID. The per-record presence lock remains the executor lease. An unresolved offer, active/uncertain launch or another native owner in any related record blocks a competing launch. No new long-lived global executor lock or coordinator is required.

Test order at the accepted seams: reject alive/unknown owners and conflicting work; admit one departed bound owner under the existing lease with exact native ID/folder; make launch intent and its notice atomic and idempotent; refuse a competing record's launch; preserve the complete input through pre-start refusal and explicit repair; keep started/uncertain attempts fenced; connect actual managed dispatch and verify same-ID continuation after native exit. Final dispatch must recheck ownership and reservation state after preparation.

Driver selection remains a required integration check: bound native identity wins over incompatible saved preferences; never pass a model belonging to another harness, fall back to a fresh session, or silently substitute a model. The current managed source requires complete driver settings and the runner's inspection currently projects resume support without native model settings. Resolve that seam explicitly before claiming the incompatible-preference acceptance case. Persistent session creation must not precede the required launch-intended fact.

## Durable launch admission checkpoint

The host now accepts a validated launch-intended fact only from its current executor process under an owned presence lease. It holds the existing registration lock across current-registration checks, related-record checks and the final selected-record transaction. Related-record reads run outside the selected record's append lock. Admission verifies exact binding, original folder, current epoch, first eligible input, and confirmed departure of every known owner. Matching native history means harness plus session ID even across interfaces or folder spellings.

The intent projects the agreed notice exactly once. An unresolved launch blocks later native offers, another launch and cancellation of its reserved input; replay uses the same guard. Returning owners remain visible as conflicts. Registry reads do not retire lifecycle or listening requests. The configured native registry root is explicit; a moved record's parent directory supplies no authority.

Seven real-record/replay tests cover these invariants. Four Muse review axes completed; replay fencing, owner-conflict presentation, shared history identity and append-lock duration findings were fixed. Full check passes 1,564 tests and the binary build passes. Detailed review and runtime evidence remain under ignored artifacts/evidence/interactive-artifact-wayfinder/launch-intent-*.

This checkpoint starts no native process. Started/refused/settled facts, repaired pre-start retries, final dispatch revalidation, same-session driver selection and reconnect reservations remain required before enabling the runtime. The full acceptance criteria remain unchecked.

## Prepared launch and refusal seams

Continue at writePreparedExecution: a bound, fully prepared attempt and its launch notice belong in one launch-intended record. The connection transition composes the existing execution reducer, retaining that reducer as the attempt/outcome owner. This avoids an append gap between reserving native history and saving the prepared attempt. Bare launch intents from the earlier checkpoint remain conservatively unresolved; they grant no process creation path.

A launch-refused fact may release a reservation only after the matching execution attempt durably proves a pre-start failure and the owning executor records the same failure. The existing retry authorization then controls the same input and native target. Started or uncertain execution cannot supply that proof. Add one test at a time for atomic prepared admission, exact-target refusal, matching pre-start settlement, refusal against uncertain/completed execution, and repaired same-input retry. These are machine-made implementation choices within the accepted shared host, preparation and execution seams.

## Prepared admission checkpoint

Bound writePreparedExecution now records the complete attempt and launch notice atomically. Exact matching durable pre-start failure releases only that launch reservation; explicit retry retains its input and native ID. Unknown launches, different attempts, uncertain/completed execution and stale preparation do not release or admit work. Terminal refusals retain their audit evidence. Four Muse review axes completed and the selected fixes pass the full check: 1,571 tests, zero failures. Runtime remains fenced pending process launch, cleanup, model selection and reconnect integration.

A disposable Codex 0.154.0 native CLI probe confirms that exec resume without explicit model/effort uses current config instead of the interactive session's saved model/effort. Thus omitting settings cannot prove preservation. HCN native settings selection must be resolved before runtime admission. The probe also found that the local HCN build classifies Codex warning messages as terminal failures; native response completion is not counted as normalized success. Evidence is under ignored native-model-inheritance-* artifacts.

HCN warning correction completed in isolated upstream commit 6c1bf6d; guidance commit 28e8ad3. Nonfatal Codex items remain visible without terminal failure; actual turn.failed and stream errors remain terminal. Full upstream check passes 986 tests in both runtimes, four Muse reviews and isolated native resume confirmation. Consumer pin/fixtures remain pending.

## Native settings integration seam

Machine-made next slice: extend HCN passive inspection and verified headless resume to preserve the exact native target and its latest recorded model, effort and provider. Inspection returns a bounded, typed snapshot and fingerprint; invocation rechecks it before native spawn. Missing or changed evidence holds the same input. Browser preferences supply no native settings authority. Codex CLI is the first verified source; unsupported adapters stay unavailable. The design and review live in ignored native-settings-design artifacts. This holds scope and retains HCN ownership of native formats and argv.

Passive inspection is implemented in isolated HCN commit e84eb0b, with guidance b57f7bd. The operation reads the latest recorded model/effort and session-header provider without creating a process. Full upstream checks pass 1,013 tests in both runtimes, all four Muse review axes are resolved, and the actual disposable native session reads successfully. File ambiguity, special files, malformed or incomplete history, incompatible folders and unsupported adapters refuse. This is source evidence only: verified invocation, permission preservation, process provenance and Lucid runtime integration remain pending. Runtime admission stays fenced.

Verified settings resume is implemented in isolated HCN commit 4535860, guidance 0643d63. Planning and the runner independently re-read the source fingerprint. The final runner refuses changed, unavailable or mismatched evidence before spawn. Exact saved model/effort/provider selectors are rendered through HCN's shared renderer; ordinary selector admission remains unchanged. Four Muse review axes and fixes pass the complete upstream check: 1,033 tests in each runtime. An actual Codex 0.154.0 resume against the disposable local endpoint confirms the same native ID and all three saved selectors despite different current defaults. The fingerprint does not snapshot provider config contents, grant permissions or lock other native writers. Permission preservation and Lucid integration remain required before enabling automatic continuation.

Recorded permissions are now a separate passive inspection facet in HCN ff4403b, guidance 9fcf5d3. Recognized native read-only/restricted-network profiles report their recorded never/on-request approval policy. Missing, extended or unsupported metadata stays unavailable while model inspection can succeed. Last-turn selection and the fingerprint include the facet; no older permission grant is inherited. Four Muse review axes and fixes pass the full upstream check: 1,057 tests in each runtime. This is observation only, not permission restoration.

A disposable native Codex 0.154.0 interactive session recorded on-request approvals. After verified same-ID exec resume, its next turn recorded never, while the read-only sandbox stayed identical. Both processes exited and the task Herdr pane was closed. Current native exec source explicitly sets the headless approval policy except for separately configured automatic review. Do not silently change approval authority or enable bound runtime on the strength of model preservation. Investigate the documented native app-server approval channel and its saved-permission restoration before selecting the final headless transport. Evidence and design remain under ignored native-permissions-* and native-approval-* artifacts.

The isolated HCN process-adapter app-server probe submits no turn and confirms restoration of saved approval policy, model and effort against changed current defaults. It does not restore the legacy sandbox in this case: the returned sandbox follows the changed current config. Both probes exit cleanly. Native permission restoration therefore still needs verification before any turn, even with the app-server transport. The concrete open product decision is recorded in ignored artifacts/evidence/interactive-artifact-wayfinder/native-approval-decision.md: add native approval prompts and answers in Lucid (recommended), or require an interactive reconnect for sessions whose approval behavior cannot be preserved. No new approval UI, approval answer or automatic continuation is enabled pending that choice.

## Native approval channel accepted

Kevin approved native permission requests and answers in Lucid on 2026-09-12. RFC 27 v2 is accepted after two Muse review passes. The earlier open choice above is resolved. Local tickets 13-16 deliver the upstream evidence and transport, durable browser answers, and native acceptance. Ticket 08 remains fenced until those dependencies and its original acceptance checks pass. No new permission question is required.
