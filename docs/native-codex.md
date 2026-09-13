# Native Codex CLI conversations

Publish an artifact from an existing Codex CLI session and receive browser
feedback in that same session. The document can be published even if the
connection fails. Codex desktop and the other native interfaces are separate
integrations; this command does not establish support for them.

## Set up hooks

Run `lucid connection setup --interface codex-cli --hooks-file FILE [--json]`
against the explicit source of the Codex hooks configuration. For a managed
configuration, use its source file. Setup refuses a deployed file symlink.
It preserves unrelated hooks, creates a missing file, and makes no changes
when its handlers already match. A conflicting or duplicate Lucid handler,
invalid configuration, or busy setup lock returns a refusal.

Setup pins the invoking Lucid executable and its configured record root in
the hook commands. Keep that executable available. The authoring commands
and browser server must use the same record root. Moving the executable or
changing that root requires reviewing and removing the old Lucid handlers
from the source file, then running setup to install their replacements.

Review and trust the generated definitions in Codex `/hooks`. A subsequent
SessionStart, from starting or resuming the intended native session,
registers its identity. Setup does not grant trust, launch Codex, or prove
that the session is listening. Codex may load hooks from more than one
configuration layer; inspect `/hooks` for other active registrations too.
See [Codex's hook documentation](https://learn.chatgpt.com/docs/hooks).

The handlers use SessionStart and Stop deadlines of 60 seconds and an
Interrupt deadline of 3 seconds. Stop waits at most 45 seconds without a
model request. Managed headless children and native subagents cannot claim
this parent session's registration or receive its feedback.

## Author and revise

1. Use the current Lucid server's loopback origin and record root. Keep the
   selected harness, model, effort and working folder. Native connection is
   independent of a headless response preference; changing that preference
   does not attach a session.
2. Write a temporary JSON publication request. For the first publication,
   generate one stable `creationId` and retain it for retries. Include
   `workingDirectory` as the exact absolute native folder and `settings`
   with the selected `harness`, `model`, `effort` and `profile`. Include
   `serverUrl` as `http://127.0.0.1:<actual-port>` and `artifact` with
   `artifactId`, complete HTML `bytes`, `contentType: "text/html"`, and
   `version: 1`. Follow the [artifact appearance contract](artifacts.md).
3. Run `lucid artifact publish --request FILE --json`. Retain its
   `conversationId`, `artifactUrl`, `publication`, and separate `connection`
   result. Open the returned URL. Registration is resolved from verified
   native context; do not supply a guessed native session ID.
4. If publication succeeds but connection fails, keep that conversation and
   report the returned reason. Fix the named setup or ownership problem.
   Retry publication using the existing `conversationId` and unchanged
   artifact version and bytes. Do not create another record to retry a
   connection or replace a conflicting binding.
5. Once bound, run `lucid connection resume-listen CONVERSATION --json`
   using that exact ID. A `requested` result means the next Stop may start
   listening. Finish the native turn; do not keep the model polling. Report
   a held result as held, preserving the saved feedback.

For revisions, replace `creationId` with the existing `conversationId`.
Reuse `artifactId` and publish complete HTML at the next version, based on
the current document and version supplied with feedback. Preserve human
edits. Native output fences are not captured as artifact writes; use the
publication command even when native feedback includes artifact teaching.

Feedback arrives with a `<lucid-offer>` containing exact conversation and
offer IDs. Read its complete context and run the supplied `connection
receipt` command before working. Publish any revision into that same
conversation. Then write a temporary JSON response file containing `kind`
(`answer`, `question`, `refusal`, or `failure`) and plain-text `text`, and run
the supplied `connection respond` command. An artifact write alone does
not settle the offer. If receipt or response is refused, retain the offer
and report the reason; do not invent receipt or replay the work.

After a recorded response, the next Stop can wait for further feedback.
During a reserved reconnect, only the verified native process reported for
that launch can request listening on the reserved conversation. It must wait
for the reconnect requester to release its executor lock. Selecting the
conversation keeps the reservation active; the listener fulfills it only
when it connects. Selecting another conversation cannot bypass the reservation.

The reconnect source supplies one startup instruction to run the exact-record
`resume-listen` command, then finish the native turn so Stop can listen. Native
approval policy still applies to that command. A startup prompt is not feedback
and does not confirm receipt or readiness. A refused command keeps feedback
held; it is not retried automatically. Use `lucid reconnect CONVERSATION` in a terminal pane to reserve the return,
wait for the current response and cleanup, and open that same native session.
Ctrl+C cancels a pre-launch wait without stopping the current response. Duplicate
commands report the existing request. This command uses native terminal I/O;
use `connection status CONVERSATION --json` for machine-readable detection.
Browser controls and automatic bound-runtime activation remain pending.

Expiry or interruption disables listening until another explicit
`resume-listen` request in the same native session. `lucid connection
status CONVERSATION --json` reads current connection evidence. Feedback
saved while the session is not listening remains saved. Use `lucid
connection cancel-input CONVERSATION --input INPUT --json` to cancel a
saved input before dispatch starts; an offered input cannot be cancelled
through that command.

Cancelled inputs stay visible in the saved transcript. Their content is
excluded from later dispatch context, and they cannot become a pending
request again.

Headless start confirmation requires HCN's `harness-minted` identity for the exact
saved session and owned invocation. A preliminary `caller-assigned` identity stays
in the record but grants no start confirmation. Missing confirmation keeps the
launch held; it does not authorize replay.
