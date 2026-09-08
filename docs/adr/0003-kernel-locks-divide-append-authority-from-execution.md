---
status: accepted
---

# Kernel locks divide append authority from execution

Use one flock implementation. The append lock protects a transaction; the
presence lock elects the effect executor for its participation. Kernel release
on death avoids stale lock-file guesses. Epoch and lease checks remain as
protocol defenses. Mixing flock and exclusive-create lock backends would let
two processes each believe they own the record.

Revisit only with a supported platform that cannot provide the same semantics,
with crash and concurrent-writer oracles for the replacement.
