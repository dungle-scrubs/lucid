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
