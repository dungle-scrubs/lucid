# HCN operation feedback

HCN owns compatibility with the harness executable it runs. Lucid consumes
HCN's operation results. It does not probe HCN's version, compare package
or executable versions, classify them as old or unverified, or recommend
package updates. The dependency pin is a build input only.

## Operation authority

The harness boundary resolves HCN once per process and invokes that path.
Resolution retains the executable path, lookup source, and lookup folder
for failure details. Startup does not launch a version probe. A missing
executable or failed operation is reported when inspection or execution
encounters it, while conversation reads remain available.

HCN supplies the model vocabulary, session capabilities, native resume
status, and context accounting result. Lucid uses these results without
version comparisons. Fresh work does not require native resume support.
A supported resume remains supported regardless of extra version metadata.
An unavailable resume or accounting result retains its operation-specific
handling. Response shape, output limits, process cleanup, model and path
identity, native session identity, and executor ownership remain checked.

Opening a saved selection does not start a version-only preview. Settings
validation can inspect HCN's vocabulary and invocation. Managed workers
inspect the requested operation, and recovery retains its separate 1500 ms
cache and existing actions. Neither path makes version-policy decisions.

## API and presentation

Defaults and conversation responses retain a `compatibility` list for
operation failures. New diagnostics have format discriminator `v: 1` and
codes `inspection-unavailable` or `selection-unsupported`. They contain:

- the affected operation, origin, observation time, scope, and severity;
- a safe message and advice to check the operation and settings and retry;
- HCN executable path, lookup source, and lookup folder;
- optional harness name and executable path.

There are no detected, pinned, minimum, or verified-version fields. The
notice region stays outside the collapsible chat panel. Its accessible
installation disclosure shows observation time and executable resolution.
A polite live region announces each operation diagnostic once per document
lifetime; identity includes code, severity, origin, selection, operation,
and remaining executable details, excluding timestamps. There are no package
repair buttons or automatic retries. An older open client needs a page reload
after changing the server's client bundle.

Structured HCN refusals keep their issue codes. Unstructured process failures
receive a generic operation explanation; raw stderr, configuration contents,
and native session IDs are not diagnostic details. Text is bounded and
stripped of terminal controls. The existing same-origin and token boundary
protects the API.

## Historical records

Records and recorded fixtures are never rewritten. Diagnostics without the
new format discriminator are ignored by presentation. Historical driver
holds, HCN refusals, and E-HUB-03/E-HUB-05 failures get neutral failure text
when old operation details are unavailable. They retain their saved state
and recovery actions. Replaying a record does not restore version warnings
or update advice. Ordinary user and assistant message text is unchanged.
