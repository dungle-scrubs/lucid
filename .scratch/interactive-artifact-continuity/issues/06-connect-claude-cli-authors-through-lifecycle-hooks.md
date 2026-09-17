# 06: Connect Claude CLI authors through lifecycle hooks

Status: done
Blocked by: 01, 02

## What to build

Claude lifecycle and safe turn-boundary hooks connect the current authoring session to browser feedback.

## Acceptance criteria

- [x] Isolated supported hooks capture exact identity and reject stale, subagent and managed-child callbacks.
- [x] Browser feedback enters at the safe boundary without steering unrelated native work.
- [x] Receipt and response are verified separately from hook transport success.
- [x] Native process acceptance uses an isolated local response stub or approved local route, with no Anthropic model inference.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Native contract probe - Claude Code 2.1.274

Isolated `CLAUDE_CONFIG_DIR`, tmux-driven interactive session and a local Messages stub; no Anthropic inference. Findings the adapter depends on:

- Subagent Bash commands run with the parent's `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and parent process. No environment value separates them, so a tool command cannot prove its provenance.
- Subagent PreToolUse, PostToolUse and SubagentStop callbacks carry `agent_id`; parent callbacks do not. SessionStart carries `source`.
- A Stop `decision: block` reason of 20,030 characters reached the model intact.
- Escape during a waiting Stop hook sends it SIGTERM within 0.1 s. Stop does not run after a user interrupt. A prompt typed during the wait does not cancel it.
- A background task notification fires UserPromptSubmit.
- At `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` the hook still runs, but Claude Code ends the turn and delivers that reason only with the next prompt.
- PreToolUse `updatedInput` changes which permission rules match a Bash command, so command rewriting was rejected as a provenance carrier.

Evidence: `contract-probe-result.json` and `cap-probe-result.json` under the main checkout's ignored `artifacts/evidence/claude-cli-native/`.

## Implementation checkpoint

Command provenance uses the verified callback. In a Claude Code tool command, `artifact publish` (connection), `connection resume-listen`, `receipt` and `respond` save a private single-use proposal (10-minute lifetime) and print its marker. The Bash PostToolUse hook commits it only for a parent callback of the registered session and owner; a subagent's proposal is claimed and refused, and a refused bind is saved beside the publication. SessionStart registers `claude-cli` with owner corroboration; compaction, `agent_id`, and managed headless roles do not register. UserPromptSubmit stands in for the missing Interrupt callback. Stop listens through the shared lifecycle extracted from the Codex adapter, with a 19,900-byte transport and a consecutive-block count that stops listening before Claude Code's cap. `lucid connection setup --interface claude-cli --settings-file FILE` installs the four handlers through the shared setup merge. The browser offers resume-listening for not-listening and closed Claude Code connections; terminal reconnect and headless continuation stay Codex-only.

`bun run check`: 1,767 tests, no failures. The same run fixed a launch-timing flake in `managed-worker-process.test.ts` whose fixed 300-iteration wait was shorter than the worker's measured 1.3-1.7 s launch on the unmodified tree.

## Native acceptance

`acceptance.ts` under the same evidence directory drove real Claude Code 2.1.274 with hooks installed by the setup command, a real Lucid server and the local stub. A subagent's publication was refused and saved `publication-connection-failed`. The parent published, bound, requested listening and ended its turn. A browser note posted over HTTP arrived at Stop inside `<lucid-offer>`; the session recorded receipt and an `answer` outcome through PostToolUse commits. The continuation Stop listened again and Escape saved `interrupted`. Record facts: `publication-requested, bound, listener-enabled, offer-started, receipt-confirmed, offer-outcome, listener-enabled, listener-disabled`. Evidence: `acceptance-result.json`, `acceptance-run.log`.

Not established: live local-model confirmation, global installation, headless continuation (08) and protected reconnect (09) for Claude Code.
