# Create conversations with saved defaults

Status: implemented locally on feat/hub-discovery; not pushed
Blocked by: 01
GitHub: [Create conversations with saved defaults](https://github.com/dungle-scrubs/lucid-v2/issues/206)

## What to build

Create a conversation from the hub with a working folder and saved harness, concrete model, effort, and mode. User defaults configure new conversations without changing existing ones; opening a conversation starts no agent.

## Acceptance criteria

- [x] XDG user configuration follows the RFC fallback and validation rules. Built-ins select Claude Code, Opus, high, and headless-turn. Invalid configuration is visible and never silently replaced.
- [x] Resolve aliases through hcn inspection, expose them through the harness seam, and save a concrete model. Defaults are reread for new creation only; a root change requires server restart.
- [x] Creation is repeat-safe across concurrent requests, crashes, and lost responses. Compare the original client request before applying updated defaults; publish the creation receipt and folder metadata atomically.
- [x] Complete settings updates require the expected preference revision. An effort change preserves the saved model; partial or stale bundles are refused. Actual driver state remains distinct from the selection.
- [x] Legacy completion preserves compatible saved choices and defers metadata writes until explicit change or submission. Unknown or missing folders have a recoverable location state.
- [x] Demonstrate new creation, reload, a changed default, and a second creation with a fake harness inspection. No model call occurs from creation or opening. Update affected contracts and pass repository checks.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.
