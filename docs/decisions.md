# Decision register

Every decision the two planning passes ratified, with the reason each was
taken. Exported from the `plan.db` SQLite files under `.plans/` before that
directory was deleted: the planning tool that wrote them is retired, and the
pipeline is now draft-rfc -> review-rfc -> draft-tickets -> implement with
RFCs in `docs/rfc/`. The decisions outlived the tool, so they moved here
rather than staying in a binary blob nobody greps.

**Codes are per-plan.** `D-011` in `01-piping` is the live-send deferral;
`D-011` in `00-chat-substrate` is plan topology. A bare `D-011` is ambiguous -
always write the plan name with it.

This file is history, not a live register. A decision here can be superseded
by an RFC in `docs/rfc/`, and where that has happened the RFC says so. Nothing
in this file is edited to match a later change.


## 00-chat-substrate

33 decisions.

### D-001 - Protocol ownership

lucid-v2 owns the chat session protocol; pure reducer (schemas + (state,frame)->state|refusal + lease/epoch, injected clock) hosted by the durable store; extract to a package only when a second consumer exists

**Why:** Normalizer never imports chat types; adapters live in lucid-v2; a standalone package would have one consumer

<sub>decided by human, 2026-08-10</sub>

### D-002 - Sequencing authority

lucid mints seq on accepted frames; sources mint per-epoch monotonic n; epoch is the fencing token on every post-attach frame

**Why:** v3 frames had the agent acking its own seq - incoherent; fencing makes the lease enforceable

<sub>decided by human, 2026-08-10</sub>

### D-003 - Milestone-1 scope

One fully-proven vertical slice on claude-code (both headless modes + hooks adapter), then pi, codex, muse

**Why:** pi RPC mode expected to yield the strongest adapter profile second

<sub>decided by human, 2026-08-10</sub>

### D-004 - Channel authentication

Per-conversation secret minted at record creation, 0600 in record dir; file read access is authorization; same-user local processes out of threat scope; remote attach deferred

**Why:** Kills the attach-time chicken-and-egg and the first-attacher-mints hole

<sub>decided by human, 2026-08-10</sub>

### D-005 - Normalizer runtime

Both Node and Bun via injected primitives (spawn, clock, signalling)

**Why:** Makes fake-spawner tests possible; real portability boundary

<sub>decided by human, 2026-08-10</sub>

### D-006 - Knowledge representation

Code defaults + validated override file; override wins; load failure throws with file path

**Why:** v1 behavior preserved

<sub>decided by human, 2026-08-10</sub>

### D-007 - Wire transport

Deferred by decision until after the milestone-0 spike; liveness fixed transport-neutrally so the choice cannot change the state machine

**Why:** stdio only works when lucid owns the child; topology needs spike facts

<sub>decided by human, 2026-08-10</sub>

### D-008 - Capability authority

Adapter queries the active harness/registry at attach (runtime-verified); curated descriptor is the fallback

**Why:** LLM self-assertion is not verification; pi registry is runtime-extensible

<sub>decided by human, 2026-08-10</sub>

### D-009 - Human-facing test surface

Minimal TUI (raw stdio acceptable during bring-up); no browser in milestone 1

**Why:** Governing constraint defers all review surface

<sub>decided by human, 2026-08-10</sub>

### D-010 - Package name

@dungle-scrubs/harness-cli at ~/dev/harness-cli-normalizer

**Why:** Ratified

<sub>decided by human, 2026-08-10</sub>

### D-011 - Plan topology

One phased plan (00-chat-substrate) in lucid-v2/.plans covering both repos; phases mirror PLAN.md build order 1-7

**Why:** Spike feeds both packages; one ledger, one milestone-1 gate; avoids cross-plan drift

<sub>decided by human, 2026-08-10</sub>

### D-012 - Pipeline entry

PLAN.md v4 registered as the RFC as-is; RFC+REVIEW treated as externally satisfied (codex+muse, claude-code round 2, lucid ratification)

**Why:** Three converged reviews already; re-drafting would re-open settled decisions

<sub>decided by human, 2026-08-10</sub>

### D-013 - Spike mapping

PLAN.md milestone 0 IS the planner SPIKE stage; spike code in ~/dev/lucid-v2/spikes/, throwaway but kept as evidence

**Why:** Enforces the before-any-protocol-code rule via the pipeline itself

<sub>decided by human, 2026-08-10</sub>

### D-014 - Landing strategy

git init both repos; PRIVATE GitHub repos under dungle-scrubs (normalizer public later at npm publish); phase branches off main; one PR per phase merged after phase gate; cross-family review (codex, muse-spark fallback) per PR; complete means merged

**Why:** v1 precedent; user chose private for now

<sub>decided by human, 2026-08-10</sub>

### D-015 - lucid-v2 stack

Bun-first lucid-v2, plain TypeScript, no Effect; Biome + Lefthook + tsc per toolchain standards; normalizer stays runtime-neutral per D-005

**Why:** Pure reducer + append-only log gain nothing from Effect; standards policy is measurable benefit only

<sub>decided by human, 2026-08-10</sub>

### D-016 - Scope endpoint

Plan covers build order steps 1-7 only; step 8 (artifact/annotation/review surface) is a future plan

**Why:** Governing constraint: nothing review-shaped until substrate green

<sub>decided by human, 2026-08-10</sub>

### D-017 - Adapter fallback ladder

claude interactive tiers: hooks (boundary inject, lucid-aware) > cooperative (turn-end, any session) > observe-only (zero config tail) > headless takeover; resume-fork while presence holds is forbidden

**Why:** Ratified v4 content; template for every harness

<sub>decided by human, 2026-08-10</sub>

### D-018 - claude resume identity

claude identity is caller-assigned and stable across resumes on 2.1.226: always resume the original id; no rotation handling; --fork-session only for deliberate branching. Presence gate + epoch fencing are the ONLY single-writer defense - harness appends concurrent resumes into live sessions without any guard

**Why:** A-005 measurements; v1 rotation scar does not reproduce

<sub>decided by auto, 2026-08-10</sub>

### D-019 - Oracle failure policy

An invariant oracle that cannot pass is a spec amendment via iterate mode (RFC-level decision), never a silent narrowing or rewrite of the oracle

**Why:** Muse F16: rewriting oracles violates the governing constraint; escape hatches must escalate, not hide

<sub>decided by auto, 2026-08-10</sub>

### D-020 - Handoff oracle placement

Mid-flight exactly-once handoff is proven at integration (M5.4, store+modes+fake harness both sides); the reducer layer (M4.4) proves only epoch fencing, lease, liveness

**Why:** Muse F5: the reducer has no durable seq/replay - the oracle would pass without proving the property

<sub>decided by auto, 2026-08-10</sub>

### D-021 - Single-writer defense in depth

Presence gate is necessary but NOT sufficient (two headless contenders both see presence=false); epoch fencing + secret are the actual defense; a headless-vs-headless concurrent resume oracle is part of the surface: exactly one wins, loser refused stale-epoch

**Why:** Muse F20 on top of A-005/D-018

<sub>decided by auto, 2026-08-10</sub>

### D-022 - claude identity events

system/init re-emits every turn with the same session id (A-001): treat as turn-start metadata, dedupe; emit identity HarnessEvent only on first sight or id change; RED against a001-raw.ndjson

**Why:** Muse F19 vs spike evidence

<sub>decided by auto, 2026-08-10</sub>

### D-023 - M5.3 typing and entry

M5.3 splits: tail/chunking/disposition logic test-first on spike fixtures; the injection contract test-after with mandatory live-pty smoke (disposition + terminal rendering). Entry criterion: A-002/A-003 spike complete with fixtures in spikes/evidence/

**Why:** Muse F8+F10: fixtures cannot precede the spike; injection cannot be proven by fixtures

<sub>decided by auto, 2026-08-10</sub>

### D-024 - Muse decomposition review

All 21 findings of artifacts/muse-decomposition-review.md accepted and applied to implementation.md (milestone coverage, gate enumeration, escape-hatch rewrites, PR cadence)

**Why:** Cross-family review per model rubric, pre-CONVERGE

<sub>decided by auto, 2026-08-10</sub>

### D-025 - Nested-session hook isolation

Spawning claude under automation (and the interactive adapter itself) must use --setting-sources project with HERDR_ENV unset for the child: inherited user-level Stop hooks (plan-db work + herdr integration) hang the nested session at 'running stop hook 0/4'. Project-only settings keep the adapter's own hooks and exclude machine-global ones

**Why:** Codex spike diagnosis, verified in preflight pid 64456: SessionStart announce + transcript path worked, natural exit

<sub>decided by auto, 2026-08-10</sub>

### D-026 - All-harness runner verification (brought forward)

codex/pi/muse now driven end-to-end through the execution-layer runner (not the protocol), per user request to do all harnesses before the reducer

**Why:** Surfaced real descriptor bugs invisible to flag-vocabulary checks: codex needs --skip-git-repo-check + close-required stdin; pi/muse need structured-output flags in launch AND resume; all three needed per-harness content decoders (distinct event vocabularies). D-003's claude-first-through-the-PROTOCOL rule is intact - the protocol reducer (M4.2+) still does not exist; this is runner-level compatibility only. Verified 4/4 via smoke:all against installed CLIs. Landed as normalizer PR #4.

<sub>decided by human, 2026-08-11</sub>

### D-027 - Remaining normalizer unknowns determined (PR #8)

Persistent-session: pi yes (--mode rpc), codex only via experimental app-server/mcp-server, muse none. Tool decoding generalized beyond shell (all four). Silent provider/auth failures now detected via terminal-error signals (pi stopReason error, claude result is_error) - verified with a real expired-minimax capture. Provider pinning works via pi provider/id model syntax. Resume-of-missing: claude/codex error, pi/muse create-if-missing (encoded as resume.onMissing); concurrent resume unguarded by design (A-005/D-018).

**Why:** User directed closing the open-questions inventory. Real limit walls remain untriggerable on demand, but the detection mechanism (terminal-error signal, not stderr matching) is now in place and proven against a real auth failure. 156 tests both lanes; 3-lens + codex review, one double-emit bug found and fixed.

<sub>decided by human, 2026-08-11</sub>

### D-028 - Per-frame counter n scope

n is the per-epoch counter on event frames only, matching PLAN.md's frame shapes; the prose 'on every frame' (L219-222) is narrowed. Replay-buffer trimming (event-ack) is event-scoped; heartbeat/ack dupes are idempotent (gated lease renewal, monotonic acked) and disposition dupes are handled by inputId idempotency in M4.3.

**Why:** PLAN.md prose and its frame shapes disagree; the shapes are the enforced interface (M4.1 review conformed codecs to them). Flagged by codex cross-family review of M4.2.

<sub>decided by auto, 2026-08-11</sub>

### D-029 - Normalizer consumption mechanism

lucid-v2 depends on @dungle-scrubs/harness-cli via file:../harness-cli-normalizer until the npm-publish decision (M7.3). The modes layer imports the real runners and injects fake spawners in tests - the runners' injected-primitives design (D-005) makes that the M3.x test approach re-used one layer up.

**Why:** Package is private/unpublished; both repos live side-by-side per D-010. file: keeps the seam one-directional (normalizer never imports protocol types - Gate 3->4 invariant).

<sub>decided by auto, 2026-08-11</sub>

### D-030 - Gate 5->6 live criteria waiver

Gate 5->6 criteria 2 (live claude rung-1 smoke) and 3 (bare-session rungs 2-3) are WAIVED-WITH-NOTE per the gate's own text. Criterion 2's injection contract is proven by spike A-002 (live claude 2.1.226) and the code-level smoke lands with M7.2's real-harness sweep (DF-3). Criterion 3 is gated on the deferred A-003 retry (DF-1); the ladder falls back to observe-only. Criterion 1 (all-three-modes exactly-once handoff) passes deterministically.

**Why:** Both are live/gated verifications that cannot run in deterministic autonomous execution; the gate explicitly marks them waivable when A-003 is deferred. No current-cutoff logic is blocked.

<sub>decided by auto, 2026-08-11</sub>

### D-031 - Gate 6->7 waiver

Gate 6->7 (a human via TUI and an agent via skill each complete a review-shaped conversation against live claude) is WAIVED-WITH-NOTE: it is fully live (TUI pty + cold-start agent + live claude). It lands with M7.2's real-harness smoke sweep. The fixture/vocabulary-provable halves are green: the TUI view-model (D-009) and the skill contract (test/skill-doc.test.ts verifies the doc's vocabulary against the code).

**Why:** Live-only verification, cannot run in deterministic autonomous execution; consistent with the DF-3/DF-TUI/DF-SKILL live-tail deferrals.

<sub>decided by auto, 2026-08-11</sub>

### D-032 - M7.1 oracle-sweep audit result

PLAN 4.7 audit: all protocol/store oracles green in lucid-v2 (two-attach, mid-turn abort, channel-auth, no-lost/no-dup input, credit starvation incl. per-class completeness, heartbeat-vs-slow-turn, cross-conversation isolation, mid-flight exactly-once handoff, identity collisions). The spawn-boundary security set (argvOrder/control-chars/path-traversal) and the resumeLast race are NORMALIZER oracles, covered in harness-cli-normalizer (test/interpretation/argv.test.ts + resume-last.test.ts) under Gate 2->3 - not re-implemented in lucid-v2. M7.1 added the two protocol-side gaps: credit-starvation-classes completeness (keyed off DROPPABLE_KINDS/LOSSLESS_KINDS) and identity-collisions (cross-conversation + intra-conversation id reuse).

**Why:** The 4.7 list spans both repos; lucid-v2 owns protocol/store oracles, the normalizer owns spawn/resume oracles. Audit confirms no protocol-side gap remained beyond the two written here.

<sub>decided by auto, 2026-08-11</sub>

### D-033 - M7.2 real-harness smoke deferral

The lucid-v2 conversation-level seven are each proven deterministically by a fake-harness oracle (mapped in docs/smoke-seven.md) and exercised at the runner layer by the normalizer's smoke:seven against live claude (D-026). The remaining live confirmation - the seven driven through store+protocol against a live harness - is DEFERRED (DF-SMOKE): nondeterministic, run-on-demand, evidence-logged, consistent with M7.2's own 'necessary but no longer the proof' framing. It does not gate the deterministic suite.

**Why:** M7.2 is explicitly test-after/nondeterministic; the invariant proof is the fake-harness suite. A live run cannot execute in deterministic autonomous CI.

<sub>decided by auto, 2026-08-11</sub>

## 01-piping

15 decisions.

### D-001 - Domain vocabulary

Go straight to RFC; no domain-modeling pass. Vocabulary is ~90% inherited from 00-chat-substrate (frames/epoch/store/fold/dispositions/adapter/transcript) and v1 (lock/direct-append/deliver/hook/env-stamp); the few new terms (CLI verbs, lock backend) are concrete.

<sub>decided by human, 2026-08-11</sub>

### D-002 - Repo scope

lucid-v2 only. The lock, store changes, and all CLI/hook entry points live in lucid-v2. Harness-side facts the interactive hooks need (--setting-sources project, hook registration, transcript path) are already normalizer 0.1.0 descriptor knowledge, consumed not changed. Landing: single-repo, per-phase PRs to lucid-v2 main.

<sub>decided by human, 2026-08-11</sub>

### D-003 - Cross-process lock approach

SPIKE a pure-Bun/O_EXCL-only append lock first (same-machine, single-user threat model per D-004) before committing to v1's bun:ffi flock. Primary chosen from the spike: if O_EXCL is sufficient, avoid the FFI dependency; else port v1's flock-primary + lockfile-fallback design (D-049). Registered as assumption A-001.

<sub>decided by human, 2026-08-11</sub>

### D-004 - Interactive injection contract

RE-SPIKE the hook injection contract on live claude 2.1.227 (A-002 proved it on 2.1.226; hooks/setting-sources behavior is version-sensitive). Herdr-automatable: interactive claude in a pane, SessionStart->announce->attach, PostToolUse boundary->inject, assert FEEDBACK visible + terminal continuity. Registered as assumption A-002.

<sub>decided by human, 2026-08-11</sub>

### D-005 - Append transaction: fold-under-lock

KILL the RFC's 'transient append MUST NOT fold' invariant. Every append is the full single-writer WAL transaction inside the lock's critical section: acquire lock -> catch-up-fold from the last known byte offset -> reduce against current state -> write-all (loop on short writeSync) -> fsync -> release. Rollback offset captured from the locked file immediately before the write, never a stale open-time goodBytes. This eliminates the stale-state atomicity race (review problem 1) because state is recomputed inside the critical section the lock already provides.

**Why:** War council (Strategist/Historian/Maverick/Operator): sequence-assigning append-only logs (SQLite single-write txn, git index.lock read-modify-rename, Raft/Kafka leader-epoch) serialize the whole read-decide-append, not just the byte write. The no-fold rule was a premature optimization baked in as a constraint.

<sub>decided by auto, 2026-08-11</sub>

### D-006 - Live-host delivery: host follows its own log (A1)

A live host MUST follow (tail + atomic catch-up-fold) its own log rather than relying on files-at-rest to push. A second process's direct-append is picked up by the running host's tailer and folded into delivery under the same lock. REJECT the socket/FIFO (fork A2) and the queue-only (A3). Delivery guarantee is durable AT-LEAST-ONCE with idempotent dedup, NOT exactly-once - the crash-between-deliver-and-ack window is unclosable (Two Generals / end-to-end argument). The RFC's 'filesystem covers every same-machine case' claim is corrected: files give durability, a live consumer must follow the store.

**Why:** War council: mbox/qmail/maildir precedent - a live reader + shared append-file breeds a second source of truth (durability in log, liveness in socket, allowed to disagree on death). A2 is 'the mbox dotlock trap wearing a stopwatch' and reopens the scoped-out transport question. Same-machine single-user makes fs.watch/poll latency a non-issue.

<sub>decided by auto, 2026-08-11</sub>

### D-007 - The flock IS the executor lease (delivery ownership)

The single flock holder is the ONLY process that may dispatch effects (run onEffect). This closes the delivery-ownership gap (a durable log converges state but does not elect the effect owner). Add a delivery cursor (persisted as a log record / the fold offset) and an idempotency key (effect-id) at the harness boundary, so 'only the lock holder dispatches, from the cursor forward, marking each effect done' falls out. ~40 lines against the reducer, no new conversation-state machine.

**Why:** War council Contrarian earned this: byte ordering != side-effect ownership. Maverick/Historian/Strategist counter: the fencing token is already on the table (the flock) - it doubles as the executor lease the Contrarian says is missing, kernel-elected on acquire, revoked on death.

<sub>decided by auto, 2026-08-11</sub>

### D-008 - Lock backend: flock(2) via bun:ffi, single mandated backend

MANDATE flock(2) via bun:ffi as the SINGLE lock backend - no per-process selection, no O_EXCL lockfile running concurrently (flock and lockfile do not interoperate; a mix lets two processes both hold). O_EXCL CANNOT release on holder death (kernel fact: it only reports pathname existence, no association with a dead process). Port v1's core/lock.ts flock path; do NOT port the concurrent lockfile-fallback-with-stale-steal (its unlink race corrupts the source of truth). CANCEL spike A-001 - the backend is decided, not an empirical question.

**Why:** War council unanimous. flock's advisory lock is tied to the open file description and dies with the process - the whole reason it exists. Same-machine local FS is the clean regime (NFS caveat moot). git punts stale-lock removal to the human, fatal for automated handoff.

<sub>decided by auto, 2026-08-11</sub>

### D-009 - Interactive liveness: presence-flock, not heartbeat

Interactive-session liveness is derived from a lucid participant sidecar HOLDING a presence flock for the session lifetime, bound to the claude process's death via pipe-EOF reap (as tmux/screen/journald do). Liveness = 'is the presence flock held', a kernel property with no clock - so a long tool-free reasoning stretch cannot expire it (review problem 4). This SUPERSEDES the hook-driven heartbeat (hooks fire only at tool boundaries, unbounded gaps) for the interactive profile. It is NOT a beating supervisor (a heartbeat proves the process beats, which can outlive a hung session). Headless profile keeps the lease/heartbeat (lucid owns the process). Transcript mtime is enrichment/activity evidence only, not the liveness signal. Must-get-right: binding the presence holder's death to the session's death.

**Why:** War council Strategist/Historian/Maverick/Operator: hooks are an EVENT stream, liveness is a CONTINUOUS property - sampling continuous with a gappy source is a category error. The held presence-flock collapses forks B and C into one primitive.

<sub>decided by auto, 2026-08-11</sub>

### D-010 - Security/isolation corrections

(a) The env-stamp is NOT a trust boundary: lucid announce MUST verify the conversation identity from the record (meta.json) it is about to write, not trust LUCID_RECORD_DIR alone (a stale/reused env could point a hook at the wrong conversation). (b) --setting-sources project loads ALL project .claude hooks, not only lucid's - lucid MUST detect/coexist with pre-existing project hooks, not assume exclusivity (D-025 isolation claim corrected). (c) INJECTION_CAP MUST be measured in encoded UTF-8 bytes (post-JSON-escape), not code points. (d) Hook commands and self-invocation MUST use exec-form argument arrays, never interpolated shell strings.

**Why:** War council Contrarian + RFC review: several security claims overstated. Verify (b) and the transcript-flush-during-reasoning question in spike A-002.

<sub>decided by auto, 2026-08-11</sub>

### D-011 - Defer live-send to a running host (scope cut)

01-piping does NOT support 'lucid send' reaching a LIVE host mid-turn. Handoff = a clean baton-pass at a boundary: the interactive session yields/ends, then a headless 'lucid run' takes over by folding the durable log (the proven D-020 exactly-once handoff). 'lucid send' queues an input that the NEXT 'lucid run' folds; nothing feeds a running host. This DEFERS workstream B entirely (host-follows-its-log tailer, the executor-lease effect-dispatch rule, the delivery cursor, at-least-once/dedup) to a future plan - and with it the Contrarian's delivery-ownership gap, which only bites when >1 process could dispatch the same effect. Consequences: 'lucid run' folds once at start and does NOT tail; the presence lock is the LIVENESS signal only, not an executor lease (no cross-process dispatch contention exists in this scope). Decisions D-006 and D-007 are DEFERRED (recorded for the future live-delivery plan, not implemented in 01).

**Why:** User choice (Maverick's provocation): fundamentals-first. Removes the biggest, most concurrency-heavy, least-proven part while still delivering all three goals (stable headless, tighter interactive, seamless handoff-by-takeover). Live delivery lands when a real need appears.

<sub>decided by human, 2026-08-11</sub>

### D-012 - RFC/scope-cut consistency (pre-decompose self-review)

Reconciled 3 residual workstream-B references to D-011: (1) Security 'locks as safety boundaries' now calls the presence lock liveness-only (was 'the executor lease: exactly one dispatcher', contradicting Terminology); (2) Alternatives A3 'queue-only send' reframed as the ADOPTED interim (was Rejected-breaks-handoff) - handoff shown unbroken via baton-pass D-020, only live mid-turn deferred; (3) Alternatives daemon 'followers' relanguaged to 'a participant that's always on'. Validates clean, no warnings.

**Why:** Surgical scope-cut edits left the Security section contradicting the revised Terminology and the Alternatives rejecting what 01 now adopts; user asked for a pre-decompose review pass.

<sub>decided by auto, 2026-08-11</sub>

### D-013 - Landing strategy

Per-phase PR to lucid-v2 main (3 PRs: A append-transaction, C CLI/hooks/presence, D handoff smoke); branch per phase; per-milestone boundary review = opus reviewers + gpt-5.6-sol codex cross-family; manual PR via gh/git; .plans ledger writes ship to main per implement-plan sequencing.

**Why:** Matches the 00-chat-substrate discipline that shipped 7 phases cleanly; keeps each workstream independently reviewable and revertible.

<sub>decided by auto, 2026-08-11</sub>

### D-014 - A-002 spike outcome (2.1.227)

All 3 injection contracts confirmed on 2.1.227. M2.3 builds inject on PostToolUse boundary delivery; project-hook COEXISTENCE is required not optional (C2 proves --setting-sources project co-runs all project hooks); Stop-hook turn-end delivery is best-effort only (did not fire this run). D-009 presence-lock justified: during a tool-free turn zero hooks fire AND transcript mtime freezes for the whole turn, so both hook-heartbeat and mtime liveness gap - only a held presence lock is reliable.

**Why:** Spike evidence spikes/evidence/A-002.md; unblocks Phase 2.

<sub>decided by auto, 2026-08-11</sub>

### D-015 - M1.1 boundary review outcome

flock append-lock passed the milestone boundary review (3 opus lenses + gpt-5.6-sol codex). Fixed: fd leak on acquire exception paths (fd-ownership try/finally); throwing closeSync skipping held.delete (nested release finallys); throwing onEvent sink stranding the lock (isolated emit + idempotent release, handle built before emit); NaN/Infinity/negative timeoutMs infinite hang (validate + monotonic performance.now clock); Atomics.wait buffer hoisted to module const. acquireWith marked @internal + kept out of the store barrel so a production caller cannot inject a fake flock. Deferred (honest): errno-precise flock failure classification (codex F3) - fails-closed, cannot occur on the D-004 same-machine local-disk scope, documented in-code. 121 tests pass.

**Why:** Cross-family review (Claude implemented, gpt-5.6-sol reviewed) found two High fd/termination bugs that unit tests missed; fixing at the milestone boundary keeps the concurrency primitive correct before M1.2 builds the append transaction on it.

<sub>decided by auto, 2026-08-11</sub>
