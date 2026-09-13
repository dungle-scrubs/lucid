# 16: Confirm native approval continuation and reconnect

Status: claimed
Blocked by: 14, 15

## What to build

The disposable native lane proves same-ID settings preservation, one native request answered through Lucid, response completion and cleanup before reconnect.

## Acceptance criteria

- [ ] A native CLI-authored session continues with its exact ID, model, effort, provider and supported permissions.
- [ ] A native approval waits for an explicit browser decision and receives exactly that decision.
- [ ] Cancellation, process loss and reconnect preserve queued feedback and executor ownership.
- [ ] Pin and recording integration, full Lucid gates, build and review pass before the supported runtime lane is enabled. Desktop acceptance remains separately tracked.

## Parent

RFC 27 v2, extending RFC 26 and ticket 08. Machine-made slicing under Kevin's autonomous implementation instruction. Local tracker only.

## Implementation seams

Machine-made under the accepted RFC and autonomous instruction: first prove the HCN subprocess channel with the existing fake process seam. The native approval mode keeps stdin for exact decisions, puts the complete prompt in a private temporary file, preserves the native fingerprint and ID, and retires its answer channel on process exit or cancellation. The managed executor then binds this channel to one recorded attempt, admits normalized requests privately, and claims each durable write intent before pipe submission. Record-tail notifications trigger only the current owner's saved decisions. Any request admission refusal, including overflow, ends the owned attempt and settles its requests after cleanup. Native settings inspection, connection launch intent, same-ID continuation and reconnect admission follow through the existing runtime and ownership seams. Final checks include public HCN transport, real records, browser decisions, local native confirmation, build and Muse review before activation.

## Transport and preparation

The HCN channel, private managed approval handler, passive settings projection and prepared fingerprint handoff are implemented. Channel admission precedes HCN spawn, a second channel cannot start the same attempt, and cleanup waits for process exit. The source keeps permission events private, forwards saved-decision notifications and treats a native request as a response to its initial silence check. Native preparation records the saved native settings and one atomic launch notice without applying browser setting overrides.

Four Muse review axes and their scoped fixes pass the full check (1,600 tests) and build. Review and test evidence is under ignored artifacts/evidence/interactive-artifact-wayfinder/lucid-native-transport-review-01*. The worker-process fixture uses the existing idle-duration injection to remove its production batching delay; production timing and ownership assertions are unchanged.

Explicit bound executor admission and one lease-bound source attachment are now implemented and reviewed, with 1,608 tests passing. They preserve current native identity and recheck ownership, registration and eligible input under the existing lock ordering.

Final dispatch now holds fresh native admission ordering through HCN creation and rejects changed ownership or context before invocation. A complete real-host/source/fake-HCN response records one permission decision and sends it once. The reviewed dispatch slice passes 1,615 tests and build. This is deterministic source integration, not live native or desktop acceptance.

Native launch start and cleanup now have separate durable facts. Start requires the expected harness-minted identity and this host's consumed invocation. Cleanup requires the matching ended attempt and an owned-source cleanup report; a terminal response alone retains the reservation. Proven pre-start refusal is recorded automatically. Cleanup never clears uncertain execution or authorizes replay. Four Muse review axes report no findings; 1,617 tests and build pass. Evidence is under ignored native-launch-lifecycle-* artifacts.

The runtime remains fenced. Reconnect, pin/recording integration and live native acceptance remain required.

## Identity confirmation correction

The native source confirmation found that a caller-assigned identity triggered the host's native-start operation and its authority refusal stopped the turn. Managed execution now stores the preliminary event while waiting for harness-confirmed identity before recording start. The existing real-host/source/fake-HCN approval test includes both identities and proves the intermediate intended state, one approval answer, response and cleanup. Full check passes 1,692 tests; all four Muse review axes report no findings. Native testing also found that HCN's verified app-server resume response was mislabeled caller-assigned; its upstream correction and native rerun remain separate work. Incomplete native test attempts retain uncertainty and are not replayed. Runtime activation remains fenced.

## Native confirmation checkpoint

The isolated Codex CLI/local-Qwen read-only lane now completes browser send, one real native file approval answered through Lucid, a saved response and owned cleanup, followed by public terminal reconnect of the exact same session and actual listening. The CLI baseline, headless response and reconnected turn preserve native ID, folder, model, effort, provider, on-request policy, restricted network and read-only filesystem. The reconnect waits under the current executor lease; it fulfills only after actual native listening. Final native exit is 0 with verified cleanup and fresh owner absence. One fixed startup command needed its own native approval, granted once for this disposable test. All task panes are closed. Detailed evidence and limitations are in ignored full-native-supported-03-* artifacts.

HCN ae9060c corrects its verified app-server identity authority after exact native response validation; guidance 8512149 documents it. Both HCN runtimes pass 1,142 tests, build/package checks pass, four Muse axes report no findings, and skill claims/tests pass. Lucid c53ded3 passes 1,692 tests and build. Prior incomplete disposable attempts remain held and unreplayed. The binding is a controlled real-process fixture; automatic worker activation, pin/recording integration, browser connection controls and remaining native interfaces are still pending. Workspace-write remains unsupported rather than silently narrowed.
