# 04: Connect Muse authors through bounded listening

Status: blocked
Blocked by: 01, 02

## What to build

Muse integration connects its authoring session and supported Stop continuation to saved browser feedback.

## Acceptance criteria

- [ ] Supported isolated project hooks capture native identity and corroborated ownership without changing the selected model.
- [ ] Bounded waiting and interruption revoke readiness without claiming native exit.
- [ ] Verified receipt and response commands run in the same native session with complete feedback.
- [ ] Real Muse acceptance proves the native loop, its configured deadline and explicit reconnect after interruption.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Native contract verification

The current official extending guide confirms `.muse/hooks.json`, SessionStart, Stop and subagent callbacks. It does not list an Interrupt event. The configuration and interactive pages require login in the documentation fetch surface; their cached login pages are not contract evidence. The older shared agent-setup reference describes an unverified plugin-only route and does not govern the current project-hook format.

Prior isolated Muse 1.1.1-R2514.1 probes established a 45-second Stop wait, a blocked Stop continuation and cancellation of a waiting hook. Before enabling the adapter, verify parent/subagent lifecycle provenance, exact identity in command execution, managed-child exclusion with Muse's cleared hook environment, and durable interruption through the native cancellation path. Reuse the common registry, listener, capture and receipt/outcome seams; no alternate queue or inferred readiness. Scope holds under RFC 26. Native fixture metadata belongs under ignored evidence.

## Command provenance blocker

Native Muse 1.1.1-R2514.1 with `muse-spark-1.3-contributor` passed the parent/child callback probe. Only the parent emitted SessionStart and Stop; child and observer callbacks used distinct session IDs and explicit SubagentStart/SubagentStop events. This supports lifecycle exclusion but does not prove which native session invoked an external receipt command.

The default managed shell and the documented `--enable-shell-tool` path both lacked `MUSE_CURRENT_SESSION_LOG` in parent and child commands. The default shell commands shared one process parent. The controlled role marker reached tool commands but was removed from every hook callback. No environment values were recorded; the probe compared only the named native-context field and a synthetic marker. The candidate field came from public binary strings, not a documented command-identity guarantee.

Keep the adapter unavailable until a supported bridge independently associates command execution with the exact native session and distinguishes managed headless callbacks. A callback-carried tool integration may be possible, but rewriting arbitrary shell commands or accepting a model-supplied ID is not a verified replacement. This is a native integration/provenance blocker, not evidence that HCN can safely infer the missing identity. The requested Muse feature remains open in scope; other tickets can proceed. Evidence: `muse-provenance-parent-child-result.json`, `muse-command-provenance-result.json`, corresponding metadata events, and `muse-current-help.txt` under ignored evidence.
