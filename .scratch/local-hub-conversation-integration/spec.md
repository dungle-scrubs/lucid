# Local hub conversation integration

Status: published

Source: [RFC 15: Local hub conversation integration](../../docs/rfc/15_local-hub-conversation-integration.rfc.md), revision 3, Draft. Decision map: [Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199).

This ticket set renders the five resolved decisions. Kevin approved the eight-ticket breakdown and shared-tracker publication on 2026-09-07. Publication completes the planning handoff; implementation has not started.

## Implementation slices

| Ticket | Blocked by | End-to-end result |
| --- | --- | --- |
| [Discover and group real conversations](issues/01-discover-and-group-conversations.md) | None | Open the hub and find the same local conversations that the terminal creates. Group each under its nearest repository root or starting folder, while retaining the exact working folder and existing artifact interactions. |
| [Create conversations with saved defaults](issues/02-create-with-saved-defaults.md) | Discover and group real conversations | Create a conversation from the hub with a working folder and saved harness, concrete model, effort, and mode. User defaults configure new conversations without changing existing ones; opening a conversation starts no agent. |
| [Generate stable short conversation titles](issues/03-generate-stable-short-titles.md) | Create conversations with saved defaults | Show a useful title immediately after the first prompt, generate it once using the selected model, and let the person rename it. Every displayed or newly saved conversation title has seven words or fewer. |
| [Resume native sessions consistently](issues/04-resume-native-sessions.md) | Create conversations with saved defaults | Continue the same native session on successive headless turns and after its terminal process departs. Preserve the starting folder and selected mode, and reuse the session when the model changes within a supported harness. |
| [Start accepted prompts with durable workers](issues/05-start-durable-managed-prompts.md) | Resume native sessions consistently | Submit a prompt in the hub and have an independent worker start or resume the conversation. Accepted work survives tab closure, simultaneous sends, worker contention, and a server crash before launch. |
| [Transfer recorded context across harnesses](issues/06-transfer-recorded-context.md) | Start accepted prompts with durable workers | Switch harnesses and continue with the recorded conversation, then return to a prior harness with the work it missed. An explicitly chosen fresh continuation receives the same recorded context rather than an empty conversation. |
| [Summarize history within verified context limits](issues/07-summarize-bounded-context.md) | Transfer recorded context across harnesses | Continue a long conversation on a selected route by summarizing older history automatically, retaining recent messages and mandatory current content, and showing when a summary is used. |
| [Recover failed and interrupted turns](issues/08-recover-failed-and-uncertain-turns.md) | Summarize history within verified context limits | When startup or execution cannot finish, show what happened and only the recovery actions that can work. Preserve the submitted prompt, its partial results, and the selected model while the person chooses how to continue. |

Title generation and native recall can proceed independently after saved defaults. Each remaining dependency supplies behavior its successor consumes: native recall before managed launch; launch before cross-harness coverage; bounded context before complete failure recovery. Each ticket targets one fresh implementation context. Discover and group real conversations is the first unblocked implementation ticket. The RFC retains Draft status; publication approval does not silently change its lifecycle status.

## Delivery boundaries

Each slice keeps the repository checks green and supplies a runnable or independently verifiable behavior. Managed execution remains explicitly gated until supported routes, context transfer, and safe recovery are complete. Early slices expose unavailable paths as holds, not silent fallbacks. The title-generation slice is independently required for release, but it is not a blocker of native recall or failure recovery.

Changes to the hcn public capability contract belong in hcn and reach Lucid through a deliberate pinned update with recorded fixtures; do not recreate descriptors above Lucid's harness seam. Title isolation is part of the naming slice; full context accounting and resume budget handling are part of context transfer; read-only multi-pass preparation is part of summary delivery.

The [independent revision-1 review](../../docs/rfc/15_local-hub-conversation-integration.review-revision-1.md) is answered point by point in revision 2. The [focused revision-2 follow-up](../../docs/rfc/15_local-hub-conversation-integration.review-revision-2.md) is answered in revision 3, including the remaining fact types, hold release, source compatibility, and explicit-attachment intent. The pre-launch crash window remains a documented conservative uncertainty. These documents specify future behavior; no RFC 15 application code or live-model confirmation has been produced by this planning task.

## Shared publication

Published eight issues with native blocking dependencies. The decision map's Handoff links this specification and the issues; its decision children are resolved.

- [Discover and group real conversations](https://github.com/dungle-scrubs/lucid-v2/issues/205)
- [Create conversations with saved defaults](https://github.com/dungle-scrubs/lucid-v2/issues/206)
- [Generate stable short conversation titles](https://github.com/dungle-scrubs/lucid-v2/issues/207)
- [Resume native sessions consistently](https://github.com/dungle-scrubs/lucid-v2/issues/208)
- [Start accepted prompts with durable workers](https://github.com/dungle-scrubs/lucid-v2/issues/209)
- [Transfer recorded context across harnesses](https://github.com/dungle-scrubs/lucid-v2/issues/210)
- [Summarize history within verified context limits](https://github.com/dungle-scrubs/lucid-v2/issues/211)
- [Recover failed and interrupted turns](https://github.com/dungle-scrubs/lucid-v2/issues/212)
