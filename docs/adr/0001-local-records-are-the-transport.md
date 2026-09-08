---
status: accepted
---

# Local records are the transport

lucid serves one person on one machine. Durable files carry the conversation;
an optional browser server reads and appends to them. There is no coordinating
daemon or socket transport. This keeps process lifetime separate from the
conversation and makes local filesystem access the authorization boundary.

Revisit only if the product's users and scope change to require remote or
multi-user coordination. That is a product decision, not a refactor.

The hub may coordinate invocation-scoped worker launches from accepted managed
input. Its reconciliation lasts for the running server's lifetime. Workers use
the same record and executor lease; this adds neither another transport nor a
global daemon. The server itself remains outside execution ownership.
