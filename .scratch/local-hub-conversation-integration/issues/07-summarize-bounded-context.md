# Summarize history within verified context limits

Status: open
Blocked by: 06
GitHub: [Summarize history within verified context limits](https://github.com/dungle-scrubs/lucid-v2/issues/211)

## What to build

Continue a long conversation on a selected route by summarizing older history automatically, retaining recent messages and mandatory current content, and showing when a summary is used.

## Acceptance criteria

- [ ] Use verified hcn input bounds, accounting, native-resume handling, and enforceable read-only summarization. Supply missing public capabilities through hcn; verify the built-in Claude/Opus route before default launch is enabled.
- [ ] A separate selected-model operation summarizes older history in bounded passes without using the working native session or performing the pending task. Preserve decisions, user constraints, unresolved work, failures, and source references.
- [ ] Summaries remain derived caches keyed to source coverage and model. Record changes invalidate affected ranges, and the full durable conversation remains intact and retrievable through the offered copy.
- [ ] Current artifact and RFC comparison context are never silently truncated. If mandatory material cannot fit or summary preparation fails, retain the pending input and show the applicable hold.
- [ ] Browser status discloses summary use. Deterministic tests cover multi-pass bounds, oversized current content, failed isolation, unavailable accounting, changed records, and retrieval of omitted history.
- [ ] Demonstrate a long-history switch and subsequent source retrieval through fake hcn, with no live-model result presented as gating proof. Update contracts and pass repository checks.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.
