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
