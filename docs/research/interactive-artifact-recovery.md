# Existing Lucid and HCN continuation boundary

Research for [Verify the existing Lucid and HCN continuation boundary](https://github.com/dungle-scrubs/lucid/issues/256). Produced inline by the parent Codex session on 2026-09-11. No production changes were made. Concurrent working-tree changes were preserved.

## Finding that changes the design question

**Observed in source and deterministic tests:** automatic continuation after a recorded terminal owner exits already exists. It retains the verified native session ID and saved working folder, uses headless-turn, and preserves the saved interactive preference. This effort must connect artifact creation and feedback delivery to that ownership path. It must not assume the recovery mechanism is absent. [Lucid runtime, openDrivenConversation](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/runtime.ts#L222), [departed-terminal test](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/test/cli/runtime.test.ts#L149).

**Observed in an isolated working-tree probe:** publishing an artifact does not attach a source or record native identity. A managed browser input also does not appear in the current interactive hook reader's queue. Capturing the ID alone will therefore not complete feedback delivery. Probe method and limits are below; the stable queue exclusion is visible in [readQueuedInputs](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/modes/interactive-host.ts#L116).

## Ownership and reusable behavior

| Boundary | Finding and standing | Source |
| --- | --- | --- |
| Artifact publication | **Observed, working-tree probe:** writeArtifact accepts a standalone artifact with no attachment and no native identity. Publication is not registration. | Probe below; working-tree src/store/conversation-host.ts, writeArtifact. |
| Interactive registration | **Observed in committed source:** announce uses a verified record stamp, corroborates a Claude ancestor, attaches an interactive Claude source and records harness-minted identity. It is not a generic four-harness registration adapter. | [announce](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/hooks/announce.ts#L48), [nativeOwner](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/harness/native-owner.ts). |
| Interactive presence | **Observed in source/tests:** presence uses PID, start time and executable identity. Any recorded live owner blocks takeover; unknown is not absent. An older live owner is not erased by a newer departed one. | [process-owner](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/process-owner.ts), [native-owner tests](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/test/store/native-owner.test.ts). |
| Executor acquisition | **Observed in source/tests:** runtime checks terminal ownership before launch and rechecks after acquiring executor authority. A terminal attaching during acquisition prevents launch. | [runtime](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/runtime.ts#L347), [race test](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/test/cli/runtime.test.ts#L264). |
| Native continuation | **Observed in source/tests:** departed interactive participation needs matching harness and verified native identity from the relevant epoch. Runtime checks resume support and launches in the saved folder. Saved interactive preference remains unchanged. | [runtime continuation](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/runtime.ts#L364), [resume validation](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/runtime.ts#L500), [native recall test](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/test/cli/runtime.test.ts#L149). |
| Existing hooks | **Observed in committed source:** PostToolUse supplies queued input at a hook boundary; the cooperative gate is disabled and otherwise falls back to observation. This does not prove an idle live listener. | [inject](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/hooks/inject.ts), [selectRung](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/modes/interactive-host.ts#L284). |
| Managed browser feedback | **Observed:** serve enables managed launch; the working-tree server accepts browser input as managed when that launcher exists. readQueuedInputs excludes execution-backed inputs. The synthetic probe reproduces this exclusion. | [serve](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/serve.ts#L40), [hook queue](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/modes/interactive-host.ts#L116); working-tree src/server/server.ts, acceptInput managed option. |
| Refusal presentation | **Observed, working-tree probe:** an interactive-start E-HUB-03 hold with a specific reason becomes the generic historical-inspection explanation when no diagnostic is attached. The screenshot's text is reproduced at the projection boundary. | Working-tree src/protocol/execution-view.ts, historicalHoldMessage and executionViews; probe below. |
| Transcript notice | **Observed in source/tests:** existing transition text says the terminal exited and continuation uses headless-turn. The runtime test checks that restart does not repeat it. It does not contain the user's requested native-ID notice. | [runtime](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/runtime.ts#L364), [notice assertions](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/test/cli/runtime.test.ts#L149). |

## HCN's boundary

**Documented:** HCN normalizes harness differences or supervises one process it spawned. Tracking and storing ownership across processes belongs to its caller. This leaves Lucid responsible for durable feedback, authority transitions, and binding a record to the originating session. [HCN ADR 0007](https://github.com/dungle-scrubs/harness-cli-normalizer/blob/2e19ca2abdfc877a6a373941def104c175f2faca/docs/adr/0007-narrow-scope-one-process-at-a-time.md).

**Documented:** HCN one-shot runs cover all four harnesses. Its persistent machine-session operation covers Claude and Pi. The machine session's caller-side handle is distinct from the native identity event. Resume accepts a native session identifier; unsupported operations return failures rather than establishing parity. These contracts support the map's allowance for headless-turn continuation, without requiring persistent headless-session support in Codex or Muse. [HCN README, Machine session, resume options, Status](https://github.com/dungle-scrubs/harness-cli-normalizer/blob/2e19ca2abdfc877a6a373941def104c175f2faca/README.md).

## Deterministic evidence

**Observed on the current working tree:** the following selected suites passed, using fake HCN and synthetic records:

```sh
bun test test/cli/managed-runtime.test.ts test/store/native-owner.test.ts test/modes/interactive.test.ts test/cli/announce.test.ts test/server/recovery-compatibility.test.ts test/store/artifact-place.test.ts test/protocol/compatibility-projection.test.ts
```

Result: 44 pass, 0 fail, 264 assertions. Log: local ignored artifacts/evidence/interactive-artifact-wayfinder/recovery-tests.log.

```sh
bun test test/cli/runtime.test.ts
```

Result: 16 pass, 0 fail, 63 assertions. Log: local ignored artifacts/evidence/interactive-artifact-wayfinder/runtime-tests.log.

The departed-terminal test launches a disposable Bun process as the recorded owner, ends that process, and verifies the fake HCN argv and cwd. It proves OS-owner transition and Lucid orchestration, not real-model memory recall. These are selected research tests, not a full repository check or live-harness confirmation.

### Incident-path probe

The isolated probe creates a temporary synthetic conversation with no presence or executor. It writes a valid artifact, checks attachment is null and native identities are empty, accepts one managed input and one ordinary input, then calls readQueuedInputs. Only the ordinary input is returned. It separately passes an E-HUB-03 held execution without a diagnostic through executionViews. The specific interactive-session refusal becomes the generic text shown in the screenshot. Assertions passed; only the probe's temporary directory was removed.

Reproduction script: local ignored artifacts/evidence/interactive-artifact-wayfinder/recovery-probe.mjs. Run with Bun from the Lucid checkout; it imports that checkout's source. Output: recovery-probe.json in the same evidence directory. This is a store/projection reproduction of the reported failure path. It is not a new full-browser reproduction or a live interactive delivery test.

## Source provenance and remaining work

The immutable Lucid links identify the research base. Runtime, announce, native-owner, process-owner, interactive-host and the departed-terminal test had no working-tree diff when checked. Server, conversation-host and execution-view were dirty, so their probe observations are explicitly working-tree evidence, not claims about the linked commit or a released binary. HCN's cited README and ADR were read separately from its concurrent descriptor work.

Graph coverage was checked for the investigated files. It reported partial runtime parsing at lines 417 and 629 and stale metadata for several dirty files. Both missed lines and the source used for conclusions were read directly; graph results were treated as navigation, not exhaustive proof. The local coverage receipt is artifacts/evidence/interactive-artifact-wayfinder/coverage.json.

**Unverified:** no live test in this research demonstrates automatic artifact registration, managed browser feedback delivery into each current interactive interface, or all four harnesses recalling native history after exit. There is no evidence here that a desktop app's shared daemon is a valid terminal owner.

The later decisions must specify registration, authenticated listener readiness, managed execution acknowledgement, client ownership where it differs from process ownership, and output folding. They must preserve the approved unknown-state behavior and add the requested pre-launch transcript notice: "No interactive session detected. Resuming headlessly with session <id>." The present findings settle what can be reused and what remains unverified; they do not choose those contracts or implement them.

## Follow-up: verify the proposed failure actions

Requested and investigated on 2026-09-11 for [Decide how artifact creation connects the originating session](https://github.com/dungle-scrubs/lucid/issues/257). Producer: the parent Codex session. The user accepted publication while disconnected and the proposed failure actions, subject to verifying their support. Accepted product behavior is distinct from present implementation support.

| Proposed action | Verified support and limitation | Plan implication |
| --- | --- | --- |
| Set up connection | **Documented:** Codex supports trusted hooks/plugins; Claude supports hooks; Pi supports extensions and /reload; the cached Muse extending reference describes hooks loaded at startup. **Observed:** current Lucid CLI help has no setup/install operation. Sources below. | A guided Lucid setup action needs implementation. A harness accepting hooks does not prove the complete Lucid integration works. |
| Copy reconnect instruction / reconnect from original session | **Observed:** copying text is not the missing operation. Lucid announce requires a pre-established record binding and specifically registers Claude. It does not establish a generic existing-session reconnect command. Native queue/message commands are delivery primitives, not proof of Lucid record registration or listener acknowledgement. | Implement and test a reconnect operation addressed by exact record identity. Do not offer an instruction claiming to reconnect until that interface supports it. A working folder alone cannot select the record. |
| Retry detection | **Observed:** Lucid can re-probe corroborated terminal process owners, and unknown remains unknown. Recovery availability repeats checks and caches capability inspection for 1.5 seconds. **Unverified:** originating Codex desktop client detection and Lucid listener detection. | Reuse process probes where ownership is established. A new UI action still needs wiring; it must not launch an agent or treat a repeated unknown result as exit. |
| Retry connection | **Unverified end to end:** no tested general reconnect/listener handshake across the five scoped interfaces was established. Existing attach frames and Claude announce are partial mechanisms. | Requires the same interface-specific connection work as initial registration. Do not present it as a universal working button. |
| Retry resume | **Observed:** installed HCN runtime inspection accepts headless-turn resume for Claude, Codex, Pi and Muse. **Observed in Lucid:** same-session retry is offered only in eligible pre-start failure states with valid identity and runtime support. Failed-after-start and uncertain outcomes expose only continue-fresh in the inspected recovery policy. Missing identity can also admit generic retry without ensuring native recall. | A generic retry control does not satisfy this flow. Require the recorded native identity and prohibit fresh fallback. Later ownership/delivery decisions must specify whether an already-dispatched input can be replayed; uncertain work cannot be treated as safely unsent. |
| Cancel send | **Observed in isolated HTTP probe:** posting action cancel to the existing input recovery endpoint returns 400 and leaves the queue log unchanged. The execution fact parser rejects a cancellation fact. | This is new Lucid functionality. It must durably prevent later dispatch of a still-queued input and arbitrate against concurrent delivery. Removing a visible message would not suffice. Withdrawal after harness acceptance is a separate, unverified capability. |
| Explicit handoff | **Observed in existing owner tests:** a living recorded terminal owner blocks headless takeover even after detachment. **Unverified:** a general release operation that safely transfers ownership while the interactive process remains open. | The previous proposed handoff exception is not an existing action. It requires an explicit ownership contract and tests; it must not be represented as an Assume closed control. |

### Owning sources

- Lucid's [recovery availability](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/server/recovery-availability.ts) was unchanged from the cited commit. [Process-owner probing](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/process-owner.ts), [announce](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/hooks/announce.ts), [CLI dispatch](https://github.com/dungle-scrubs/lucid/blob/61733ba4e04a8d8cd5dce381f832b90b3d0adeac/src/cli/dispatch.ts), and the runtime/native-owner tests linked above supply the remaining committed evidence. CLI help was run from the current source.
- The cancellation endpoint and retry-policy results were probed against the dirty working tree: src/server/server.ts, POST inputs/:id/recovery; src/protocol/execution.ts, parseExecutionFact and recoveryPolicy. These are current local observations, not release claims. Relevant source was read directly after graph coverage reported changed metadata. The HTTP probe covered the current recovery endpoint; it is not an exhaustive claim about every possible low-level frame.
- [Codex hooks: discovery](https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks), fetched through the official documentation tool on 2026-09-11. Installed `codex queue --help` accepts a session UUID or exact name. The earlier Codex research documents why shared-daemon/thread status does not establish desktop-client presence.
- [Claude hooks](https://code.claude.com/docs/en/hooks#command-hook-fields), rechecked 2026-09-11: asyncRewake can wake an idle session when a hook exits with code 2. This does not establish receipt, deduplication, or withdrawal of a Lucid input.
- Pi 0.85.1 installed docs/extensions.md, placement for /reload and pi.sendUserMessage sections; [official extension reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md). A loaded extension can send user input while idle or use an explicit busy delivery mode. No Lucid extension was installed during this investigation.
- Muse 1.1.1 installed `session-message --help` exposes list/send. The [official session-messaging page](https://dev.meta.ai/docs/muse-code/session-messaging) again returned only an inaccessible page shell. Wakeup, durable delivery acknowledgement, and listener liveness remain unverified. The earlier cached [extending reference](https://dev.meta.ai/docs/muse-code/extending) documents startup hooks; no hook configuration was changed.

### Verification receipts

The isolated action-probe.mjs under local ignored artifacts/evidence/interactive-artifact-wayfinder starts a temporary loopback server over a synthetic record, submits the unsupported cancellation request, and checks the unchanged durable log. It also asserts the current retry policy and that unknown presence stays unknown. It closes its server and deletes only its temporary record directory. Output: action-probe.json. No existing user record or harness session was touched.

For each harness, HCN was called with inspect, --runtime, --mode headless-turn, a synthetic UUID, --prompt, and --cwd /tmp. Results were filtered to harness, executable version and resume status before display. All four reported supported: Claude 2.1.268, Codex 0.154.0, Pi 0.85.1, Muse 1.1.1. HCN help explicitly states this inspection does not run a model or prove a saved session exists. Output: action-resume-inspection.json. No actual resume or native-message send was performed.

Focused verification command:

```sh
bun test test/server/recovery-compatibility.test.ts test/server/recovery-input-identity.test.ts test/cli/runtime.test.ts test/store/native-owner.test.ts
```

Result: 20 pass, 0 fail, 80 assertions. Local log: action-tests.log. The earlier broader 60-test research results remain separate. This follow-up is verification work; no production code was changed.

### Accepted constraints carried forward

The artifact may publish and open even when connection fails. Feedback remains saved and queued with the specific reason. One-time setup and a required reload/restart are acceptable. Offer actions only when their underlying operation is supported for that interface and valid in the current state. No Assume closed action, no guessed record from a shared folder, and no fresh-session substitution. Cancel send is an accepted requested capability that still needs implementation, limited to input whose non-delivery can be guaranteed. Interface support remains conditional until its integration acceptance tests pass.
