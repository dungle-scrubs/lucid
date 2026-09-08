---
status: accepted
---

# Browser and agent content have separate authority

The browser uses a server-lifetime token; the more powerful attach secret stays
on the filesystem. Artifacts run outside lucid's origin, and frame messages
are validated. Attachments offered to an agent are copies outside the record,
so a context path does not reveal the record directory.

Revisit each boundary only with a concrete threat model and equivalent tests;
do not widen authority for convenience.
