---
number: 01
title: "Piping: cross-process operation of the chat substrate"
type: feature
status: Review
author: Kevin Frilot
date: 2026-08-11
---

# RFC-01: Piping: cross-process operation of the chat substrate

> Revised after RFC review + war council, then scope-cut (D-011). The
> "direct-append + lock, no daemon" thesis stands; the original over-claims
> are corrected (D-005..D-010). Scope cut: **live-send to a running host is
> DEFERRED** - handoff is a clean baton-pass (interactive yields -> headless
> folds the log -> takes over, the proven D-020), so `lucid run` folds once
> and does not tail, and no process feeds a live host mid-turn. That removes
> workstream B (follow-tailer, executor lease, delivery cursor,
> at-least-once/dedup) and the delivery-ownership gap from 01 entirely
> (D-006/D-007 are deferred). What remains: the single-writer **append
> transaction under a `flock`** (transient hooks and `lucid send` still race
> on appends), the CLI/hook entry points, and a **held presence lock** as
> the interactive liveness signal.

## Abstract

The `00-chat-substrate` milestone delivered a fully-tested chat/session
substrate - a pure protocol reducer, a durable store, headless and
interactive source adapters - proven against a fake harness and, for the
headless path, against live claude. It runs today only in a single
process. This RFC specifies the **piping** that makes the substrate
operable across multiple same-machine processes so a user can run a
conversation headlessly via the harness-cli-normalizer, participate from
an interactive claude session, and hand off between the two - all
coordinated through the shared on-disk conversation record, with no daemon
and no socket. The mechanism is a single-writer append-only log whose
every append folds-decides-writes under a `flock`; interactive liveness is
a held presence lock, not a heartbeat; and handoff is a baton-pass at a
boundary (a successor folds the durable log and takes over - the proven
`D-020`). Excluded: the daemon, any UI, the socket/RPC transport, remote or
multi-user access, and (deferred, `D-011`) delivering to a running host
mid-turn.

## Introduction

**Problem.** The substrate's correctness is proven, but it is unusable as
anything but a library: no command runs it, no second process can touch a
live conversation, and nothing stops two OS processes from corrupting the
log. Every capability the rebuild promised - a stable headless contract, a
tighter interactive contract, seamless handoff - needs this piping.

<!-- D-002 --> **Scope (in),** `lucid-v2` only:

1. A single-writer **append transaction** on each conversation's
   `log.ndjson`: fold-decide-write-fsync under a `flock`, plus a transient
   (open-append-close) path for short-lived processes.
2. **CLI and hook entry points** - `lucid run`, `lucid announce` / `lucid
   inject`, `lucid send`, `lucid watch` - mapped to protocol frames, plus
   env-stamping and self-invocation.
3. **Interactive rung-1 adapter wiring** (the `M5.3` logic) to real claude
   hooks + transcript, with a **presence-lock** liveness signal.
4. A **same-machine two-process handoff smoke** - baton-pass handoff, the
   live `D-020`.

<!-- D-011 --> **Scope (out):** a long-running **daemon**; any **UI** (the
rich terminal application; `lucid watch` emits the view-model, it is not
that app); the **socket/RPC transport** (decision 7.2); **remote or
multi-user** access; and **live-send to a running host mid-turn** -
deferred, with it the follow-tailer, the executor lease, the delivery
cursor, and the at-least-once/dedup delivery-ownership machinery
(`D-006`/`D-007`, recorded for a future live-delivery plan). Later layers,
on top of this one.

**Motivation.** The three rebuild goals - stable headless CLI use, a
tighter interactive contract, seamless handoff - all depend on this
piping. The substrate encodes them as invariants; this RFC makes them
runnable.

**Context.** Builds on `00-chat-substrate` (merged, `complete`) and ports
proven semantics from lucid v1 (`~/dev/lucid`), which solved this exact
cross-process log coordination.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as in RFC 2119.

- **Conversation record.** The on-disk directory: `secret` (0600),
  `meta.json` (identity), `log.ndjson` (the durable log), and the lock
  targets below.
- **Append transaction.** The single-writer critical section for one
  commit: acquire the append lock, catch-up-fold from the last byte
  offset, reduce, write-all, `fsync`, release. Both the long-lived host
  and the transient (direct-append) path use it; the terms
  "direct-append" and "transient append" both name a short-lived process
  performing one such transaction and exiting.
- **Append lock.** An exclusive `flock(2)` on a sibling `<log>.lock`,
  held only for an append transaction.
- **Presence lock.** An exclusive `flock(2)` on `<record>/presence.lock`,
  held for the LIFETIME of a source's participation. Held ⟺ a source is
  attached; this is the interactive liveness signal (a kernel property, no
  clock). Distinct from the append lock (different file, different
  lifetime). In 01 it signals liveness only; it does not gate effect
  dispatch (there is no cross-process dispatch contention - `D-011`).
- **Executor lease / delivery cursor** *(deferred, `D-006`/`D-007`)*. The
  future live-delivery plan's rule that only the presence-lock holder
  dispatches effects, from a persisted cursor, giving at-least-once with
  boundary dedup. Out of 01 scope; recorded for when live-send lands.
- **Env-stamp.** Env vars lucid sets when configuring a harness (record
  dir, turn id) so a spawned hook finds its conversation - an untrusted
  hint, verified against `meta.json`, never a trust boundary.

## Motivation

Covered under Introduction: the substrate is a proven library with no way
to be run, shared, or driven interactively - exactly the capabilities the
rebuild exists to deliver.

## Design

### A. The append transaction (single-writer log discipline)

<!-- D-005 --> Every append - by the long-lived host or a transient hook -
MUST execute as one transaction inside the append lock: **acquire lock ->
catch-up-fold from the last known byte offset -> reduce against the
resulting current state -> write the entry with a write-all loop ->
`fsync` -> release.** The reduce MUST see current state, so the fold step
is REQUIRED, not forbidden; the earlier "transient append MUST NOT fold"
rule is withdrawn - it was a premature optimization that caused the
stale-epoch/seq race. This is the standard sequence-assigning append-only
log discipline (SQLite's single write transaction, git's
`index.lock` read-modify-rename, Kafka/Raft leader-epoch): the whole
read-decide-append serializes, not just the byte write.

<!-- D-005 --> The write MUST loop on a short `writeSync` return (a short
write under disk pressure does not throw); a partial write MUST NOT be
counted complete. On any write/`fsync` failure the transaction MUST
truncate to the byte offset captured **under the lock immediately before
the write** (never a stale open-time offset, which could delete another
process's committed entry) and raise the store's `append-failed`.

A **fold that establishes an append offset or truncates MUST hold the
append lock.** Only a pure read-only viewer MAY fold lock-free (tolerating
a torn trailing line); a lock-free fold that truncates could shorten the
file under a concurrent writer.

### B. Handoff by baton-pass (live delivery deferred)

<!-- D-011 --> 01 does NOT deliver to a running host mid-turn. `lucid
send` transiently appends an `input` frame that the **next** `lucid run`
folds; nothing feeds a process that is already running. Consequently a
`lucid run` host folds its log ONCE at start and does NOT tail. **Handoff
is a baton-pass at a boundary:** the interactive session yields (or ends),
then a headless `lucid run` (or another source) attaches, folds the
durable log, and takes over - the exactly-once handoff proven
deterministically as `D-020` in `00-chat-substrate`, now exercised across
real processes by workstream D. Because at most one process ever
dispatches effects for a conversation at a time (the single live source),
there is no cross-process effect-dispatch contention in this scope - the
executor-lease / delivery-cursor / at-least-once machinery (`D-006`,
`D-007`) is deferred to the future live-delivery plan.

### C. CLI, hooks, and interactive liveness

`lucid-v2` MUST expose a CLI mapping subcommands to frames and the store:

- `lucid run <conversation>` - headless. Creates/opens the record, folds
  the log ONCE, acquires the **presence lock**, opens a headless source on
  the normalizer's real spawn adapter (`nodeRunnerDeps`), and drives the
  conversation as the single live source (no tailer - `D-011`). (Promotes
  `scripts/smoke-live.ts`.)
- `lucid announce` - SessionStart hook. Reads the payload from stdin,
  resolves the record from the env-stamp, <!-- D-010 --> **verifies the
  identity against `meta.json`**, and transiently appends `attach` (+
  identity).
- `lucid inject` - PostToolUse/Stop hook. Resolves + verifies, reads
  queued input, transiently appends the delivery and `disposition`, emits
  the injection as hook output.
- `lucid send <conversation> <text>` - transiently appends an `input`
  frame; the NEXT `lucid run` folds it (not delivered to a running host -
  `D-011`).
- `lucid watch <conversation>` - a read-only viewer that folds the log and
  emits the TUI view-model, refreshing as the log grows (it does NOT hold
  a lock and does NOT dispatch; see Open Question 1 for the UI boundary).

<!-- D-010 --> Env-stamping and self-invocation MUST be ported from v1
(`launch/env-stamp.ts`, `cli/self.ts`), and hook commands + self-invocation
MUST use **exec-form argument arrays**, never interpolated shell strings.

<!-- D-009 --> **Interactive liveness.** The interactive profile's
liveness MUST derive from a **presence lock held for the session
lifetime** by a lucid participant bound to the claude process's death
(pipe-EOF reap, as tmux/journald do) - "attached" ⟺ the presence lock is
held, a kernel property with no clock. This SUPERSEDES the hook-driven
heartbeat for the interactive profile: hooks fire only at tool boundaries,
so a long tool-free reasoning stretch would otherwise expire the 15s
lease mid-turn. It is NOT a beating supervisor (a heartbeat proves a
process beats, which can outlive a hung session). The **headless profile**
keeps the reducer's lease/heartbeat (lucid owns the process and can
heartbeat it). Transcript `mtime` MAY enrich activity display but MUST NOT
be the liveness signal.

<!-- D-010 --> The adapter MUST configure claude with `--setting-sources
project` and `HERDR_ENV` unset (`D-025`), and MUST NOT assume that
isolates lucid's hooks exclusively - the project source loads ALL project
`.claude` hooks, so lucid MUST detect and coexist with pre-existing
project hooks. Injected input MUST be chunked under a cap measured in
**encoded UTF-8 bytes** (post-JSON-escape), not code points, and reported
with an accurate `disposition`.

### D. Same-machine handoff smoke

There MUST be an on-demand smoke running **two real processes** sharing
one conversation - a headless `lucid run` and a second participant -
asserting a handoff is ordered and at-least-once (no lost input, deduped
on replay), under the real `flock`, with the reopened fold matching the
live transcript across the handoff. Being live/nondeterministic, it is
run-on-demand with evidence logged (like `smoke-live.ts`).

## State Machine

No new conversation states: `channelStatus` and `decideAction` carry over.
Two liveness *signals* coexist by profile: the reducer's heartbeat/lease
for headless (lucid owns the process), and the held **presence lock** for
interactive (kernel-elected, no clock). New local lifecycles: the append
lock (per transaction, always terminating in release or
kernel-release-on-death) and the presence lock (acquired at attach, held
for the source's lifetime, kernel-released on process death). Handoff is a
baton-pass: a successor attaches only after the incumbent's presence lock
is free, folds the log, and takes over.

## Error Handling

- **E001 lock-timeout** (warning). An append could not acquire the append
  lock in time. Recovery: surface the conversation and wait duration; MUST
  NOT drop the frame. With `flock` there is no stale-steal - a persistent
  timeout means a live holder; wait or report, never force-steal.
- **E002 torn-interior-line** (critical). A corrupt newline-terminated
  line in fold. MUST NOT occur under the lock; if seen, it indicates an
  unlocked writer -> `corrupt-log`.
- **E003 hook-resolution-failure** (warning). A hook could not resolve or
  **verify** (`meta.json` mismatch) its conversation. Recovery: exit
  non-destructively; the human's session proceeds without lucid rather
  than crashing or writing the wrong record.
- **E004 injection-refused** (info). A `lucid inject` delivery refused by
  the reducer. The hook MUST report the disposition; the refusal class
  dictates the response (skill-doc guidance), no blind retry.
- **E005 append-failed** (critical). Write/`fsync` error: truncate to the
  under-lock pre-write offset and raise, per D-005.
- **E006 double-or-zero-dispatch** *(deferred, `D-011`)*. Cannot arise in
  01: at most one live source dispatches for a conversation at a time.
  Returns with the live-delivery plan (executor lease + cursor).

## Security Considerations

**Trust boundary.** Same-machine, single-user (`D-004`, inherited): defends
cross-user access and accidental cross-talk; a same-user local process is
out of scope. Remote deferred.

**Secret.** Minted 0600 at creation, redacted before durable. The CLI MUST
NOT print it or pass it on argv (visible in `ps`); it travels via the file
and the env-stamp (same-user-visible only).

**Env-stamp is NOT a trust boundary** (`D-010`). A stale or reused
`LUCID_RECORD_DIR` could point a hook at the wrong conversation, so
`announce`/`inject` MUST verify the resolved conversation against
`meta.json` before writing.

**The locks as safety boundaries.** The append lock preserves
single-writer-on-disk (epoch fencing stops two logical writers; the lock
stops two OS processes interleaving bytes - both required). The presence
lock is the interactive **liveness signal only** - held ⟺ a source is
attached, kernel-released on death. In 01 it does not gate effect
dispatch: at most one live source drives a conversation, so there is no
dispatcher election to make (`D-011`; the executor-lease role is deferred
with live delivery, `D-006`/`D-007`).

**Hook isolation (`D-025`, corrected).** `--setting-sources project` loads
all project `.claude` hooks, not only lucid's; lucid MUST coexist with
pre-existing project hooks, not assume exclusivity. `HERDR_ENV` MUST be
unset for the child.

**Blast radius.** A hook is a short-lived transaction on one conversation.
Worst case bounded by the append lock (no torn lines), the reducer
(no half-applied frames, epoch fencing), and per-conversation directories
(cross-conversation isolation, `00-chat-substrate` M7.1). Injected human
text is opaque input; prompt-injection resistance is the harness's concern.

## Alternatives Considered

- **Socket / FIFO for live-host delivery (fork A2).** Rejected permanently:
  it creates a second source of truth (durability in the log, liveness in
  the socket, free to disagree on death) - the mbox/dotlock trap two
  decades of mail systems proved out - and smuggles the daemon lifecycle
  back in (who owns the socket, what on host death). The log is the one
  channel. This holds independent of the live-delivery deferral: if
  live-send ever lands (`D-006`/`D-007`), it follows its own log, never a
  socket.
- **Queue-only send until the next `lucid run` (fork A3).** This is what
  01 ADOPTS as the interim (`D-011`) - `lucid send` appends an `input` the
  next run folds. The original objection ("breaks live participation and
  handoff") is only half-true: handoff does NOT need live delivery (it is
  a baton-pass, `D-020`), so it is unbroken; only *live mid-turn*
  participation is deferred, by choice, fundamentals-first. The "you have
  new mail, restart to see it" gap is the acknowledged, bounded cost of
  the deferral, closed later by the live-delivery plan.
- **O_EXCL / pid-liveness lockfile (fork B2).** Rejected: O_EXCL cannot
  release on holder death (kernel fact); a pid check reimplements kernel
  lifetime in userspace and inherits pid-reuse and stale-steal unlink
  races that corrupt the source of truth. `flock(2)` dies with the process
  - the reason it exists.
- **Per-process backend selection (v1's `lockBackend()`).** Rejected as a
  concurrent mix: `flock` on the persistent inode and an O_EXCL lockfile
  do not interoperate, so two processes can both hold. One mandated
  backend (`flock`).
- **Hook-driven heartbeat / a beating supervisor (fork C1/C2).** Rejected:
  hooks have unbounded gaps (tool-free reasoning); lengthening the lease
  only makes wrong ownership persist longer; a beating supervisor measures
  the wrong thing. The held presence lock measures liveness at its source.
- **A long-running daemon.** The future home of a unified multi-artifact
  UI; out of scope here (a UI-experience layer, not a correctness
  requirement). This design keeps the daemon a pure later layer: because
  the log is the single channel and every process folds it, a future
  daemon is "just a participant that's always on," adding nothing the
  correctness of 01 depends on.

## Implementation Plan

Per-phase PRs to `lucid-v2` `main` (`D-014`), boundary-reviewed (3 opus +
gpt-5.6-sol) per milestone:

1. **Spike A-002 only - DONE (`D-014`, PASSED).** Injection contract on live
   claude 2.1.227 (Herdr-automated). Verified: (a) `--setting-sources
   project` **co-runs** pre-existing project hooks (coexistence required);
   (b) the transcript **flushes at the turn boundary**, not mid-reasoning
   (mtime froze for the whole tool-free turn - confirms the presence-lock
   liveness of `D-009`). Evidence: `spikes/evidence/A-002.md`. **Spike A-001
   is cancelled** - the lock backend is decided (`D-008`), not empirical.
2. **Append transaction + `flock` (A).** Test-first: fold-under-lock,
   write-all loop, under-lock rollback offset, torn-interior rejection;
   a two-writer integration check on the real `flock`.
3. **CLI + hooks + presence lock (C).** `run`/`send`/`watch` on their
   frame mapping; `announce`/`inject` with identity verification;
   env-stamp + self-invocation ported from v1; presence-lock lifecycle
   (pipe-EOF reap) as the interactive liveness signal.
4. **Handoff smoke (D).** Two-process baton-pass, on-demand, evidence
   logged. (Workstream B - live delivery - is deferred, `D-011`.)

## Open Questions

1. **RESOLVED (`D-011`).** Live `lucid send` to a running host is
   deferred; handoff is a baton-pass. Workstream B is out of 01.
2. **`lucid watch` UI boundary.** `watch` is a minimal read-only
   view-model emitter (in scope), not the rich TUI application (out).
   Confirm at DECOMPOSE. Decider: DECOMPOSE.
3. **Presence-lock reap correctness.** The one lifetime detail that MUST
   be right: binding the presence holder's death to the session's death
   (pipe-EOF) so a false-alive cannot persist. Prove in workstream C.
   Decider: implementation.

## References

**Normative:**

- `PLAN.md` (00-chat-substrate) - the substrate: protocol, store,
  decisions 7.2 (transport), D-004 (threat model), D-020 (handoff), D-025
  (hook isolation).
- `.plans/00-chat-substrate/implementation.md`, `progress-report.md` - the
  delivered milestones (M4-M7) and deferred live tails this RFC closes.
- `~/dev/lucid/src/core/lock.ts` (D-049) - the `flock` path to port (NOT
  the concurrent lockfile-fallback / stale-steal).
- `~/dev/lucid/src/core/deliver.ts` (offline direct-append branch only),
  `~/dev/lucid/src/cli/{run,ask-input,ack,self}.ts`,
  `~/dev/lucid/src/launch/env-stamp.ts` - the direct-append path, CLI
  surface, env-stamping, self-invocation.

**Informative:**

- `docs/skill-chat-substrate.md` - the source-side contract the entry
  points honor.
- `docs/smoke-seven.md`, `spikes/evidence/df-smoke.md` - the headless live
  smoke this extends to two processes.
- `spikes/evidence/A-002.md` - the injection spike, **re-run and PASSED on
  claude 2.1.227** (`D-014`): mid-turn injection, project-hook co-run, and
  turn-boundary transcript flush all confirmed.
