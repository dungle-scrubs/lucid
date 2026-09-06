---
status: accepted
---

# Recovery follows the durable log

Delivery cursors advance after dispatch. Replay is at-least-once and input IDs
provide idempotence. A notification is only a hint to read durable work. There
is no second transient transport whose loss would strand an accepted input.
Append failure must roll back both durable bytes and the corresponding state.

Revisit only with an explicit durability model and crash tests that preserve
accepted inputs across process death.
