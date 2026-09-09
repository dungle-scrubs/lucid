# Agent compatibility feedback

Lucid reports what its selected HCN installation and managed driver inspection
observed. It does not check for the latest package release or install updates.
Repair the identified installation, restart the owning Lucid runtime, then use
the existing prompt or recovery action. Reloading a browser tab does not repeat
the runtime's startup observation.

## Version authority

The harness boundary resolves HCN once for each process. Resolution preserves
`LUCID_HCN`, package dependency, module-relative, executable-relative,
working-folder, and PATH provenance. Invocation uses the same resolved path.
Only `package-dependency` identifies Lucid's distributed dependency; other
lookup roots do not establish package ownership.

The release manifest supplies the exact HCN pin in source, package, and compiled
forms. The existing minimum-version comparator still decides admission. A
version above that floor but different from the pin produces a warning.
Pin comparison trims whitespace, removes one lowercase `v`, requires complete
SemVer syntax, and compares prerelease and build metadata exactly. Malformed
identity is unknown; it does not change the floor comparator's result.

Harness version evidence comes from HCN's version-only runtime inspection.
The inspection's `verifiedAgainst` is retained separately from the descriptor
value used by the existing admission gate. A disagreement names both values
and the comparison that admitted or refused work. An unverified executable is
not described as proven broken. Version equality does not establish support
for every model, profile, native session, or context operation.

## Observation lifetime

Browser startup runs one asynchronous HCN version probe. The timeout is five
seconds, each output stream is limited to 4 KiB, and timeout kills the child.
The resulting runner retains Lucid's normal HCN process supervision. Probe or
resolver failure preserves the listener and healthy or damaged record reads.

The hub and direct conversation entry request defaults independently of the
creation dialog. Defaults awaits the shared startup observation. Conversation
reads omit pending diagnostics and make no global compatibility claim.

A complete saved managed selection starts a version-only preview using its
working folder. Reads return while that probe is pending. Settled feedback
arrives through existing record polling. The observation key includes HCN
identity, harness, model, effort, provider, profile, folder, and applicable
native resume identity. Concurrent records sharing that key share one probe.
Each record retains its current observation; changing selection releases its
previous reference. An unreferenced superseded observation is removed, so
native-session changes do not accumulate permanent entries. Polling a current
selection never refreshes its observation.

Saved interactive preferences receive no native-executable preview or
headless substitution. Missing settings or folders do not trigger guessed
preview settings. Creating, editing, viewing, or saving an artifact adds no
probe. Diagnostics never invoke a model or context accounting.

Managed workers keep their fresh execution checks. Recovery availability keeps
its independent per-server/key 1500 ms cache, fresh/resume checks, interactive
to headless assessment, and existing actions. Neither refreshes retained
startup or selection notices. A later successful worker does not erase the
browser runtime's historical startup observation.

## API and presentation

`GET /api/defaults` and `GET /api/conversations/:id` add a `compatibility` list
without changing status codes or existing fields. Each entry contains:

- `code`, `scope`, `severity`, and the affected `operation`;
- fixed `observedAt` and `origin`: runtime-start, selection-check,
  execution-check, or session-handshake;
- safe `message`, manual `remedy`, and HCN pin, floor, detected version,
  selected path, resolution source, and lookup root;
- nullable harness name, path, detected version, runtime verified version,
  and the verified version actually used by admission.

Codes are `hcn-version-drift`, `hcn-version-too-old`,
`harness-version-unverified`, `selection-unsupported`, and
`inspection-unavailable`. Preview failures warn when they refuse no operation.
Required-check failures remain errors under their existing outer code and
outcome. Known structured refusal issues are preserved; unstructured process
output produces a generic inspection-unavailable explanation. HCN 0.6.5's
argv/runtime inspection refusals can be prose-only, so those cannot provide a
more specific structured issue. Lucid does not infer one from their wording.

One notice region sits below the hub header or document toolbar, outside the
collapsible conversation panel. Installation details use a native disclosure
with visible keyboard focus. The region scrolls independently on short or
narrow screens. There are no compatibility action buttons or pending controls.

One polite live region announces each applicable observation once per document
lifetime. Identity includes code, severity, origin, selection, operation, and
installation/version facts; it excludes timestamps and polling. Settings
responses mark errors already represented in compatibility feedback with
`errorInCompatibility`, so existing forms do not announce them again.

Compatibility holds and error events can carry additive structured facts.
Replay preserves those facts without changing execution states or recovery
policy. Projection uses them for new messages. Historical driver holds and
HCN refusals without structured evidence use neutral repair advice instead of
forwarding old process prose. Stored events are never rewritten. Facts are
shape-checked, bounded, stripped of terminal controls, and rendered as text;
raw stderr, arguments, configuration contents, and native session identities
are not diagnostic details. The existing same-origin and token boundary
protects the API.
