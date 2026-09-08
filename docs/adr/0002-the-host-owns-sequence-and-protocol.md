---
status: accepted
---

# The host owns sequence and protocol

lucid owns a pure reducer with injected time, host sequence numbers, and epoch
fencing. Sources supply per-epoch event counters, not durable sequence numbers.
This gives every integration mode the same replay and refusal rules. Keep the
protocol in this repository until a second real consumer needs a package.

Revisit packaging with that consumer; do not change sequencing ownership to
accommodate one harness or browser feature. The substrate remains independent
of the browser surface; its invariants are not adjusted to fit presentation.
