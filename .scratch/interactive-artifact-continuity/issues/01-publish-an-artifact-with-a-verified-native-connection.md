# 01: Publish an artifact with a verified native connection

Status: done
Blocked by: none

## What to build

Publish through one command and retain the exact record even if native registration or connection fails.

## Acceptance criteria

- [x] An idempotent publication returns its authoritative conversation ID and artifact URL separately from its connection result.
- [x] Verified native registration binds only the exact native identity, working folder, interface and corroborated owner; stale, ambiguous, subagent, or managed-child claims cannot bind.
- [x] Binding is durable and race-safe against lifecycle changes. An open but non-listening native owner has the agreed message; unavailable setup keeps the artifact readable.
- [x] Critical connection facts survive replay; the supported old reader refuses an opted-in record without modifying its bytes.

## Parent

Current checkpoint: publication, durable binding, private normalized registration, fresh status and guarded legacy headless entry are implemented and reviewed. The reader at 837bd6c refuses a newly bound record without changing its bytes; the rebuilt binary publishes and retries the same record. Native lifecycle provenance still requires completion; this ticket is not done.

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Shared publication acceptance complete

The shared registry and publication tests now cover independent native proof, lifecycle races, exact identity, stale/ambiguous claims and unavailable interfaces. Ticket 03 supplies production Codex CLI lifecycle, same-ID resume and live-Qwen publication evidence. Other native adapters remain unavailable until their own tickets pass; this shared ticket does not claim their support. See ticket 03 and ignored `codex-qwen-production-result.json`; the full check passes 1,557 tests. No global integration was installed.
