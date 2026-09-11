# RFC 23 review, v1

Reviewed version: v1, status Review. Reviewer: Claude Opus 5 (Anthropic),
through hcn. Author and implementer: OpenAI Codex. No files edited by reviewer.
Full run output is ignored evidence; this file records actionable findings.

## Structural results

The reviewing harness had no shell. The primary session ran the validator:

```json
{"passed":true,"errors":[],"warnings":[]}
```

## Findings

- B1, Design and Security, code cited: DNS pinning needs a concrete transport
  and a test proving environment proxies cannot override it.
- B2, Design, code cited: enumerate the public-address policy, including CGNAT,
  mapped IPv4, NAT64, and 6to4 exclusions.
- B3, Design and State Machine, traced: a save during validation can occupy the
  proposed version. Refuse without overwriting and give the agent current bytes.
- B4, State Machine, traced: explicit source stop must cancel pending checks
  and prevent late appends without the corresponding transcript message.
- B5, Design, code cited: new-tab behavior requires popup grants. Record the
  threat model and prove opener isolation and parent-origin separation.
- M1, Design, code cited: define the checked elements, supported URL forms,
  fragments, authored bases, and static versus script-created destinations.
- M2, Security, code cited: document automatic outbound requests before viewing.
- M3, Error Handling, traced: offline and blocked sites prevent new linked
  agent versions, including links inherited by patches.
- M4, Design, traced: total time is a budget, not a promise all 100 URLs finish;
  define normalization and refusal above the URL limit.
- M5, Error Handling, code cited: map private destinations, unsafe redirects,
  redirect exhaustion, and missing Location to explicit outcomes.
- M6, Implementation, code cited: migrate promise callers and audit aliases,
  including test fixtures that discard results.
- Minor, Implementation, traced: clear the watchdog before network work; name
  the three artifacts; update current admission and sandbox contracts.

## Cleared

The durable host is the common admission point. The append transaction is
synchronous, so network work belongs before it. Browser writer callbacks already
support promises. Sequential awaits preserve multi-block emission ordering.
Human saves remain distinct from agent versions. Both frame types share the
same sandbox setting.

## Not reviewed

No browser or transport execution by the reviewer. Primary-session tests provide
runtime evidence. Review was of the design and relevant call sites, not the
completed implementation. v2 records a response to each finding.
