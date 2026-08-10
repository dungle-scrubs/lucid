## Load-bearing problems

1. **Interactive routing has no mechanism.**  
   **File/section:** `lucid-v2/PLAN.md`, “The two paths, one stream” and “The enforced `lucid wait` interface”.

   `lucid wait` running as an agent-owned child process cannot observe its parent harness’s model deltas or take control of the terminal harness’s input. Its stdio connects only to `lucid wait`. If the running agent invokes it as a tool, it also blocks that tool call rather than concurrently forwarding the harness’s native output.

   Presence detection from v1 only answers “a process exists”; it does not create an event tap or an input handle. This is precisely why v1’s interactive mode only delivered when its own wait loop was present, otherwise queued feedback and emitted a resume command (`CONTEXT.md`, “Spawn vs Interactive (D-068)”).

   The plan needs a per-harness interactive adapter contract before implementation: subscribe to native output/tool/turn events, deliver a human message using that harness’s supported injection API, acknowledge its disposition, and reconnect. A wrapper or RPC-mode process may satisfy that contract, but then lucid owns that process and it is not the stated interactive path.

   This would be resolved by a working spike for every launch harness that streams an in-progress interactive turn and injects a human message during it without taking over the original terminal process.

2. **“One `AgentEvent` stream” does not make mode switching a transport swap.**  
   **File/section:** `lucid-v2/PLAN.md`, “The convergence”, “2-way streaming mechanics”, and “Interactive detection and the headless switch”.

   A shared render-event shape can unify tokens, tool output, and completion. It does not unify ownership, input semantics, backpressure, or recovery:

   - A headless child has OS pipe backpressure, can be aborted by its owner, and may only accept one initial prompt.
   - An interactive adapter needs application-level acknowledgement, reconnect, replay, and a harness-specific answer to “steer now, queue after the turn, or reject”.
   - A handoff needs a lease/fence, a durable cursor, idempotency keys, and an explicit drain-or-abort decision before the other writer starts.

   Without those, the v1 single-attendant invariant becomes two drivers with a common display format. `CONTEXT.md` makes the reason for that invariant explicit: a false liveness judgement risks two writers.

   Define a separate bidirectional session protocol with `conversationId`, `turnId`, monotonic sequence, message/control IDs, acknowledgements, flow credits, attach/lease state, and replay rules. `AgentEvent` can remain the one-way presentation projection.

   This would be resolved by a handoff test that crashes either side at every boundary and proves one, and only one, human message is accepted and applied.

3. **The plan both accepts and rejects Claude’s buffering limitation.**  
   **File/section:** `lucid-v2/PLAN.md`, Part 0 `output`, and Part 1 “2-way streaming mechanics”.

   Part 0 correctly records that Claude emits no response bytes until its turn finishes. Part 1 then requires all agent output to stream “as produced” and calls the Claude behavior a transport bug to fix. A normalizer that drains stdout cannot create token deltas the CLI does not expose.

   Either token streaming must be an optional per-harness capability, with progress-only events for buffered CLIs, or the launch set needs a different Claude integration that exposes deltas. As written, milestone 1 requires a behavior the named interface does not provide.

   This would be resolved by a documented, supported Claude event source that emits incremental assistant output under the intended interactive and headless modes.

4. **The direct-wake claim contradicts the channel-dead state.**  
   **File/section:** `lucid-v2/PLAN.md`, “Interactive detection and the headless switch” and “Why v2 can tell the agent directly”.

   The plan correctly says lucid cannot reach an interactive process through a dead channel. It then says the copyable-command fallback applies only when “the agent process is gone.” Those are different states: the agent can remain alive while its wait child exits, its connection drops, or it loses the app daemon.

   In that state lucid cannot wake the agent directly. It must either wait for an authenticated adapter reconnect, show a reattach/resume instruction, or refuse headless takeover while presence remains true. The “Kill ... the wait channel” test has no stated expected recovery policy.

   This would be resolved by splitting `interactive-unattached` from `agent-gone`, then specifying the allowed transition and human-visible recovery for each.

## Gaps

5. **The normalizer execution seam is right only if it stays a headless runner.**  
   **File/section:** `lucid-v2/PLAN.md`, Part 0 “Architecture” and “The execution layer is in scope”.

   Process spawning, concurrent stdout/stderr draining, structured decoding, cancellation, and a watchdog belong in a reusable direct-headless runner. That is more valuable than returning argv alone.

   It becomes the wrong seam if it owns lucid’s universal chat protocol, persistence, human-message delivery policy, path leases, or “input writer” semantics that several harnesses cannot honor mid-turn. Keep the normalizer’s public result scoped to a spawned command and its normalized runner events. Let lucid-v2 own durable conversation state and map both the runner and interactive adapters into its chat protocol. Inject runtime primitives such as spawn, clock, and process signalling so Node/Bun support is a real portability boundary, not an assumption that child-process spawning is the only difference.

   This would be resolved by an API where the normalizer can be used by a non-Lucid CLI consumer without importing Lucid types or assuming a chat.

6. **Static vision data is useful, but cannot be the final capability authority.**  
   **File/section:** `lucid-v2/PLAN.md`, “Capability surfacing”.

   A curated `(harness, model)` table is a valid baseline. It is not enough for Pi: its runtime model registry can be replaced by provider configuration, extensions can fetch and register models at startup, and each model declares its supported input types. The same model spelling can therefore be routed differently on different installations. Pi does expose image capability as model data, but that makes it a runtime query of the active registry, not a fact a generic normalizer can universally hard-code. [Pi custom-provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)

   Emit a resolved capability set with source and confidence, for example `runtime-verified`, `curated`, or `unknown`. Treat unknown as no raw-image delivery. An LLM declaring its own capabilities through the skill is not verification.

   This would be resolved by a supported query per harness that identifies the active model and its input capability, or by limiting the promise to a pinned curated configuration.

7. **The milestone test surface lacks the failure oracles that prove the substrate.**  
   **File/section:** `lucid-v2/PLAN.md`, “Fully tested means”.

   The listed tests omit explicit tests for:

   - two simultaneous attachment attempts to one native session, including stale lease takeover;
   - human interjection during token/tool streaming, including queue-versus-steer semantics;
   - process death after delivery but before durable acknowledgement, reconnect, replay, and deduplication;
   - partial and malformed NDJSON frames, stalled readers, and bounded queues;
   - concurrent unrelated sessions, identity collisions, and no cross-session event/control leakage;
   - channel authentication and authorization. Rejecting unknown `kind` values does not stop an unrelated local process from impersonating an agent or sending `end`/`switch path`.

   Real-harness end-to-end tests are necessary, but insufficient and nondeterministic for these cases. Add a deterministic adversarial fake harness plus real-harness compatibility smoke tests.

   This would be resolved by an explicit protocol state machine with invariant-based tests, especially “one active writer”, “no lost accepted input”, and “no duplicated applied input”.

## Decisions that need answers before code starts

8. **Open decision 7.4 is not deferrable.**  
   **File/section:** `lucid-v2/PLAN.md`, Open decision 4.

   The choice is not simply NDJSON versus SSE versus socket. First decide how an external interactive harness supplies and receives native events. Once that exists, select the connection transport, reconnection model, authentication, and flow control. Raw NDJSON over stdio only works if lucid owns the child process. Pi’s documented JSON/RPC mode is an example of a process-integration route, but it changes process ownership. [Pi quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md)

9. **Open decision 7.7 is load-bearing, but it is not the first call alone.**  
   **File/section:** `lucid-v2/PLAN.md`, Open decision 7 and Part 0 execution.

   Settle it immediately after the interactive-adapter contract. The normalizer should not own the global `AgentEvent` shape because the interactive source is not a normalizer operation. Either create a small transport-neutral protocol package that owns the converged chat events, or have lucid-v2 own its chat protocol and map normalizer-specific runner events into it. The former better preserves the normalizer as an independent dependency.

10. **The launch harness set and runtime target cannot wait until after execution-layer work.**  
    **File/section:** `lucid-v2/PLAN.md`, Open decisions 2 and 3, plus Build order 1-2.

    “Each launch-set harness” is a milestone commitment, yet each harness may need a distinct interactive adapter and some may not expose the required capabilities. Decide whether milestone 1 is one fully proven vertical slice or all four harnesses. Also decide Node/Bun before implementing process lifecycle, stream cancellation, signals, and test doubles. Pure descriptor work can begin before that; `streamTurn()` cannot.

11. **Capability authority and recovery authority need to become explicit decisions.**  
    **File/section:** `lucid-v2/PLAN.md`, “Capability surfacing” and “Kill and resume”.

    They are currently embedded assumptions rather than open decisions: who verifies capabilities, who authenticates an interactive attachment, and what authority permits headless takeover after disconnect. Each directly controls safe message delivery and the single-writer invariant. They belong beside 7.4 and 7.7, before the first protocol implementation.
tokens used
74,071
## Load-bearing problems

1. **Interactive routing has no mechanism.**  
   **File/section:** `lucid-v2/PLAN.md`, “The two paths, one stream” and “The enforced `lucid wait` interface”.

   `lucid wait` running as an agent-owned child process cannot observe its parent harness’s model deltas or take control of the terminal harness’s input. Its stdio connects only to `lucid wait`. If the running agent invokes it as a tool, it also blocks that tool call rather than concurrently forwarding the harness’s native output.

   Presence detection from v1 only answers “a process exists”; it does not create an event tap or an input handle. This is precisely why v1’s interactive mode only delivered when its own wait loop was present, otherwise queued feedback and emitted a resume command (`CONTEXT.md`, “Spawn vs Interactive (D-068)”).

   The plan needs a per-harness interactive adapter contract before implementation: subscribe to native output/tool/turn events, deliver a human message using that harness’s supported injection API, acknowledge its disposition, and reconnect. A wrapper or RPC-mode process may satisfy that contract, but then lucid owns that process and it is not the stated interactive path.

   This would be resolved by a working spike for every launch harness that streams an in-progress interactive turn and injects a human message during it without taking over the original terminal process.

2. **“One `AgentEvent` stream” does not make mode switching a transport swap.**  
   **File/section:** `lucid-v2/PLAN.md`, “The convergence”, “2-way streaming mechanics”, and “Interactive detection and the headless switch”.

   A shared render-event shape can unify tokens, tool output, and completion. It does not unify ownership, input semantics, backpressure, or recovery:

   - A headless child has OS pipe backpressure, can be aborted by its owner, and may only accept one initial prompt.
   - An interactive adapter needs application-level acknowledgement, reconnect, replay, and a harness-specific answer to “steer now, queue after the turn, or reject”.
   - A handoff needs a lease/fence, a durable cursor, idempotency keys, and an explicit drain-or-abort decision before the other writer starts.

   Without those, the v1 single-attendant invariant becomes two drivers with a common display format. `CONTEXT.md` makes the reason for that invariant explicit: a false liveness judgement risks two writers.

   Define a separate bidirectional session protocol with `conversationId`, `turnId`, monotonic sequence, message/control IDs, acknowledgements, flow credits, attach/lease state, and replay rules. `AgentEvent` can remain the one-way presentation projection.

   This would be resolved by a handoff test that crashes either side at every boundary and proves one, and only one, human message is accepted and applied.

3. **The plan both accepts and rejects Claude’s buffering limitation.**  
   **File/section:** `lucid-v2/PLAN.md`, Part 0 `output`, and Part 1 “2-way streaming mechanics”.

   Part 0 correctly records that Claude emits no response bytes until its turn finishes. Part 1 then requires all agent output to stream “as produced” and calls the Claude behavior a transport bug to fix. A normalizer that drains stdout cannot create token deltas the CLI does not expose.

   Either token streaming must be an optional per-harness capability, with progress-only events for buffered CLIs, or the launch set needs a different Claude integration that exposes deltas. As written, milestone 1 requires a behavior the named interface does not provide.

   This would be resolved by a documented, supported Claude event source that emits incremental assistant output under the intended interactive and headless modes.

4. **The direct-wake claim contradicts the channel-dead state.**  
   **File/section:** `lucid-v2/PLAN.md`, “Interactive detection and the headless switch” and “Why v2 can tell the agent directly”.

   The plan correctly says lucid cannot reach an interactive process through a dead channel. It then says the copyable-command fallback applies only when “the agent process is gone.” Those are different states: the agent can remain alive while its wait child exits, its connection drops, or it loses the app daemon.

   In that state lucid cannot wake the agent directly. It must either wait for an authenticated adapter reconnect, show a reattach/resume instruction, or refuse headless takeover while presence remains true. The “Kill ... the wait channel” test has no stated expected recovery policy.

   This would be resolved by splitting `interactive-unattached` from `agent-gone`, then specifying the allowed transition and human-visible recovery for each.

## Gaps

5. **The normalizer execution seam is right only if it stays a headless runner.**  
   **File/section:** `lucid-v2/PLAN.md`, Part 0 “Architecture” and “The execution layer is in scope”.

   Process spawning, concurrent stdout/stderr draining, structured decoding, cancellation, and a watchdog belong in a reusable direct-headless runner. That is more valuable than returning argv alone.

   It becomes the wrong seam if it owns lucid’s universal chat protocol, persistence, human-message delivery policy, path leases, or “input writer” semantics that several harnesses cannot honor mid-turn. Keep the normalizer’s public result scoped to a spawned command and its normalized runner events. Let lucid-v2 own durable conversation state and map both the runner and interactive adapters into its chat protocol. Inject runtime primitives such as spawn, clock, and process signalling so Node/Bun support is a real portability boundary, not an assumption that child-process spawning is the only difference.

   This would be resolved by an API where the normalizer can be used by a non-Lucid CLI consumer without importing Lucid types or assuming a chat.

6. **Static vision data is useful, but cannot be the final capability authority.**  
   **File/section:** `lucid-v2/PLAN.md`, “Capability surfacing”.

   A curated `(harness, model)` table is a valid baseline. It is not enough for Pi: its runtime model registry can be replaced by provider configuration, extensions can fetch and register models at startup, and each model declares its supported input types. The same model spelling can therefore be routed differently on different installations. Pi does expose image capability as model data, but that makes it a runtime query of the active registry, not a fact a generic normalizer can universally hard-code. [Pi custom-provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)

   Emit a resolved capability set with source and confidence, for example `runtime-verified`, `curated`, or `unknown`. Treat unknown as no raw-image delivery. An LLM declaring its own capabilities through the skill is not verification.

   This would be resolved by a supported query per harness that identifies the active model and its input capability, or by limiting the promise to a pinned curated configuration.

7. **The milestone test surface lacks the failure oracles that prove the substrate.**  
   **File/section:** `lucid-v2/PLAN.md`, “Fully tested means”.

   The listed tests omit explicit tests for:

   - two simultaneous attachment attempts to one native session, including stale lease takeover;
   - human interjection during token/tool streaming, including queue-versus-steer semantics;
   - process death after delivery but before durable acknowledgement, reconnect, replay, and deduplication;
   - partial and malformed NDJSON frames, stalled readers, and bounded queues;
   - concurrent unrelated sessions, identity collisions, and no cross-session event/control leakage;
   - channel authentication and authorization. Rejecting unknown `kind` values does not stop an unrelated local process from impersonating an agent or sending `end`/`switch path`.

   Real-harness end-to-end tests are necessary, but insufficient and nondeterministic for these cases. Add a deterministic adversarial fake harness plus real-harness compatibility smoke tests.

   This would be resolved by an explicit protocol state machine with invariant-based tests, especially “one active writer”, “no lost accepted input”, and “no duplicated applied input”.

## Decisions that need answers before code starts

8. **Open decision 7.4 is not deferrable.**  
   **File/section:** `lucid-v2/PLAN.md`, Open decision 4.

   The choice is not simply NDJSON versus SSE versus socket. First decide how an external interactive harness supplies and receives native events. Once that exists, select the connection transport, reconnection model, authentication, and flow control. Raw NDJSON over stdio only works if lucid owns the child process. Pi’s documented JSON/RPC mode is an example of a process-integration route, but it changes process ownership. [Pi quickstart](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md)

9. **Open decision 7.7 is load-bearing, but it is not the first call alone.**  
   **File/section:** `lucid-v2/PLAN.md`, Open decision 7 and Part 0 execution.

   Settle it immediately after the interactive-adapter contract. The normalizer should not own the global `AgentEvent` shape because the interactive source is not a normalizer operation. Either create a small transport-neutral protocol package that owns the converged chat events, or have lucid-v2 own its chat protocol and map normalizer-specific runner events into it. The former better preserves the normalizer as an independent dependency.

10. **The launch harness set and runtime target cannot wait until after execution-layer work.**  
    **File/section:** `lucid-v2/PLAN.md`, Open decisions 2 and 3, plus Build order 1-2.

    “Each launch-set harness” is a milestone commitment, yet each harness may need a distinct interactive adapter and some may not expose the required capabilities. Decide whether milestone 1 is one fully proven vertical slice or all four harnesses. Also decide Node/Bun before implementing process lifecycle, stream cancellation, signals, and test doubles. Pure descriptor work can begin before that; `streamTurn()` cannot.

11. **Capability authority and recovery authority need to become explicit decisions.**  
    **File/section:** `lucid-v2/PLAN.md`, “Capability surfacing” and “Kill and resume”.

    They are currently embedded assumptions rather than open decisions: who verifies capabilities, who authenticates an interactive attachment, and what authority permits headless takeover after disconnect. Each directly controls safe message delivery and the single-writer invariant. They belong beside 7.4 and 7.7, before the first protocol implementation.
