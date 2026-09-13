# 14: Answer one native approval during verified resume

Status: resolved
Blocked by: 13

## What to build

A caller runs one exact resumed response through HCN and answers its native permission request over the same live process channel.

## Acceptance criteria

- [x] The opt-in public command refuses unsupported combinations before spawn and verifies effective settings before any prompt.
- [x] Command, file and permission choices preserve exact offered scope; unsupported variants fail with owned cleanup.
- [x] Duplicate decisions, clear/write races, concurrent requests, channel loss and deadlines retain at-most-one native response write.
- [x] Node and Bun public and injected-process tests pass; ordinary run/session behavior remains covered.

## Parent

RFC 27 v2, extending RFC 26 and ticket 08. Machine-made slicing under Kevin's autonomous implementation instruction. Local tracker only.

## Implementation seams

Machine-made under the accepted protocol: public hcn run/inspect planning selects one opt-in transport, while the injected one-turn runner owns the native process and decision channel. First prove a synthetic command-approval round trip through the public CLI, then native-settings mismatch and request delivery races, followed by file/permission variants and real native confirmation. Existing channel backpressure, line assembly, turn supervision and process termination remain shared. No Lucid native-protocol parsing is introduced.

## Verification

HCN commit 3200c95 implements the opt-in one-turn native transport. Full check passes 1137 tests in each runtime, then build and package checks. Skill claims and negative checks pass against that build. Two Muse review rounds were applied; lifecycle, framing, settings, concurrent requests, clear/write races, duplicate IDs, terminal output and cleanup have deterministic oracles.

Disposable local Qwen runs through the built public HCN command confirm exact-session command and file approvals, one answer write, expected file contents, clean child exit and unchanged model/read-only/user-review settings. The last file run also confirms ordinary tool activity, streamed text and completion. Evidence lives under artifacts/evidence/interactive-artifact-wayfinder in the original Lucid checkout: native-approval-local-file-final-confirmation.json, native-approval-local-live-confirmation.json, native-approval-review42-fixes.md and native-approval-transport-45-check-after-load.log.

The verified lane retains exact read-only/restricted/user settings. Unsupported native scope variants fail with cleanup. Lucid browser integration, broader native lanes, dependency publication and desktop acceptance remain separate tickets.
