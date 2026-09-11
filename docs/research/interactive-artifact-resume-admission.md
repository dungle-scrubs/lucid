# Native resume admission: documentation check

Research for [Decide automatic resume and ownership when interfaces change](https://github.com/dungle-scrubs/lucid/issues/259). Produced inline by the parent Codex session, 2026-09-11. This is a documentation check, not a native concurrency test. No model was invoked and no user session was resumed.

## Finding

**Unverified:** the sources below do not establish a common way to prevent a newly opened interactive process from loading or writing the native session while a headless process owns it. Blocking a submitted prompt is a different operation. The accepted policy to finish the current headless turn before interactive reconnect therefore still needs native admission evidence.

## Evidence by interface

| Interface | Supported surface and standing | Remaining question |
| --- | --- | --- |
| Codex CLI | **Documented:** UserPromptSubmit can reject a prompt. SessionStart identifies startup/resume/clear/compact and accepts common output fields. The guide explicitly describes stopping a post-compaction continuation, but does not specify a pre-load resume veto. [Codex hooks: SessionStart](https://learn.chatgpt.com/docs/hooks#sessionstart), [UserPromptSubmit](https://learn.chatgpt.com/docs/hooks#userpromptsubmit), retrieved 2026-09-11. | **Unverified:** when resume loads history relative to SessionStart; whether a native cross-process lock prevents a second owner; cancellation, timeout, and refreshed-history behavior. Do not interpret a stopped hook run as proof that native resume was refused. |
| Codex desktop | **Unverified in the actual desktop:** the runtime hook contracts above do not establish the app's per-thread admission or loading behavior. Prior CLI listener evidence does not answer this. | A separate desktop acceptance test must prove the same ownership property. Terminal or isolated app-server evidence cannot establish the installed app's behavior. |
| Claude Code | **Documented:** SessionStart has no blocking decision control. UserPromptSubmit can block prompt processing. Most timed-out hooks produce no decision. [Claude hooks: decision control](https://code.claude.com/docs/en/hooks#decision-control), [timeouts](https://code.claude.com/docs/en/hooks#timeouts), retrieved 2026-09-11. | **Unverified:** native cross-process protection and a supported alternative before resume loads history. Waiting in SessionStart is not a durable admission veto. No Anthropic model call is needed for this documentation finding. |
| Pi | **Documented for installed 0.85.1:** session_before_switch can cancel /resume and supplies targetSessionFile. session_start fires when a session is started, loaded, or reloaded. input can return handled to skip agent processing; extension commands run before input and can bypass that event. [Official extension reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#session_before_switch). Read from installed package docs/extensions.md, lines 393-432 and 909-960, on 2026-09-11; the URL is a moving navigation pointer. | **Unverified:** cold-start --session admission before history loading, native cross-process exclusion, and all execution paths. The in-app switch veto cannot be generalized to a new process. |
| Muse | **Documented:** the extending guide lists SessionStart, UserPromptSubmit, and PreLLMCall, among other lifecycle hooks, and validates hooks at startup. It does not specify a pre-load resume veto or native lock ordering. [Muse extending: lifecycle events](https://dev.meta.ai/docs/muse-code/extending), cache refreshed within 24 hours, read 2026-09-11. | **Unverified:** native session-lock conflict behavior and ordering relative to hooks. Prior orderly same-ID resume and Stop-listener probes did not test competing writers. An event's name alone does not establish blocking semantics. |

## Bounded next probe

Use a synthetic saved session and a local provider stub or native echo mode. Hold an owned headless turn open, then attempt the supported native interactive resume of that exact ID. Inspect only this fixture's native history, process identities, model requests, and hook events.

The probe must distinguish native refusal, opening an existing shared runtime, independent loading with writes, and a safely waiting interface. Exercise direct interactive input, hook cancellation, hook timeout, and normal headless completion. After completion, verify whether the returning interface sees the final history or needs a fresh resume. Also test reopening immediately before and during headless process creation.

Test fresh-process resume separately from in-app session switching. A native lock that refuses a second process may provide exclusion but does not itself provide automatic waiting and reconnect. A hook that prevents model requests may still run after history was loaded or changed. No result should silently weaken one active native writer to one Lucid feedback sender.

If these native boundaries cannot support the accepted flow, return with a concrete alternative and its user-visible cost before revising the contract. Keep the ownership decision open in the meantime. This note does not implement a launcher, replace the user's interface, or promise protection against arbitrary unintegrated processes.

## Native concurrency probes, 2026-09-11

**Observed:** native behavior differs. Codex CLI and Muse rejected competing interactive resume. Pi and Claude Code allowed interactive model requests while a headless request for the same native session was still pending. These are controlled native-process observations, not a claim that every version or launch configuration behaves identically.

| Interface | Competing resume result | Continuation after headless exit |
| --- | --- | --- |
| Codex CLI 0.154.0 | Native conflict screen: This conversation is open in another app. It offered R to Retry. No second model request occurred before the headless request was released. | Explicit Retry loaded the completed headless answer. The subsequent interactive request included that answer. No automatic reconnect was observed. |
| Muse 1.1.1-R2514.1 | Native resume reported the exact session already open in another window and returned to its picker. The probe exited the picker without selecting another session. | A new exact-ID resume after headless exit restored the headless echo response. No automatic reconnect was observed. |
| Pi 0.85.1 | Interactive --session accepted the same ID and completed a local-provider request while the headless request remained held. The interactive request lacked the pending headless answer. | Both processes completed and exited. This probe does not establish safe merging or updated history in the already-loaded interactive process. |
| Claude Code 2.1.268 | Interactive --resume accepted the same ID and completed a local-provider request while the headless request remained held. Both the interactive exit hint and HCN identity retained the same ID. | Both processes completed and exited. No automatic fork was observed in this path. This does not establish history consistency across the concurrent writers. |
| Codex desktop | Not tested in the actual desktop window. | CLI evidence does not establish desktop acceptance. |

### Probe method and evidence

Codex, Pi, and Claude used loopback HTTP response stubs. They performed no provider inference. Muse's decisive lock probe used its native echo provider, seeded by an interactive session, with a project PreLLMCall hook holding the headless process until a release file appeared. All operated on synthetic session IDs and test folders. No user conversation was resumed or selected. Muse's conflict UI exposed its session picker; no picker contents are retained as evidence. No Herdr pane was created in this round.

All headless runs went through HCN. Successful Pi and Claude probes explicitly used Lucid's installed HCN 0.6.7. Test session identities were obtained from HCN/native results and independently matched to the fixture. CLI controls supplied the competing interactive requests. Timestamps in the local-provider receipts place those requests before the headless release. The Claude probe's initial hold expired during first-run onboarding; it is not counted as concurrency evidence. A second headless request, after setup, remained held while the competing interactive request completed.

Exact synthetic native IDs are retained in the local proof JSON files below. They are test-run evidence, not implementation constants.

Local ignored evidence is under artifacts/evidence/interactive-artifact-wayfinder/: codex-admission-probe.mjs, codex-admission-proof.json, muse-lock-proof.json, pi-admission-probe.mjs, pi-admission-proof.json, claude-admission-probe.mjs, and claude-admission-proof.json. Their location files point at the temporary native fixtures and request receipts. Each test process and local provider listener was stopped; targeted process and listener checks found none remaining.

Two preparation failures are excluded from these results. An initial Muse headless seed used native arguments after HCN's passthrough separator, but Muse treated them as prompt text and used the Meta provider. Its responses were synthetic but were not an echo or concurrency proof. The decisive probe instead created a verified native echo session first and resumed its stored provider without passthrough. Pi's isolated session-store override did not match HCN's existing-session lookup; the final probe used an explicit per-fixture directory matching HCN's documented-in-code cwd layout. Neither failure proves native concurrent ownership behavior. Custom session-store support and passthrough interpretation remain separate integration compatibility findings.

### Decision now exposed

The ordinary native resume path does not enforce single-writer admission for Pi or Claude in these probes. It would be incorrect to generalize Codex/Muse's native conflict protection to them. It would also be incorrect to call all hook/extension guards impossible: this work has not proved a complete fail-closed guard across their startup, cancellation, timeout, direct-input, and history-refresh paths.

Candidate A is a Lucid-controlled launch/reconnect entry point for participating sessions: wait before starting the native process, coordinate admission with the managed headless launch, finish the active turn, then start the exact native session from its updated history. This is a new user-facing workflow requirement. It protects only launches that use that entry point; ordinary native resume can bypass it unless a separate native or installed launch guard is proven. Do not describe the helper alone as universal protection.

Candidate B retains ordinary native resume and holds automatic takeover for interfaces without proven native admission until an enforceable guard exists. Interactive feedback remains in scope. This narrows immediately deliverable automatic takeover, without pretending those interfaces have parity or silently creating new sessions.

Fit check: the actual user is one person moving between a native coding session and browser artifact review. CONTEXT.md says Lucid owns the durable record and provides artifact reading and annotation. Both candidates serve continuation without competing writers. A adds a launch/reconnect surface and usage constraint; B narrows available automatic continuation. Those are product choices for the user, not conclusions to manufacture from the probes. No candidate has been accepted by this research, and the ownership ticket remains open.
