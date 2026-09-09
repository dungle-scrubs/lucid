# 01 - Explain HCN installation checks in the CLI

Status: draft
Blocked by: none
Publication: local only
Source: RFC 20, version 2 - Authority and version policy; Diagnostic contract; Presentation and repair text; Security Considerations.

## What to build

When an HCN-backed command initializes its driver, tell the person which HCN
installation Lucid selected, how its reported version compares with this
Lucid release, and which installation needs repair. A difference from the pin
warns without changing the existing execution gate or exit behavior. Existing
initialization failures carry a useful, safe explanation.

Keep installation resolution and typed diagnostic facts inside the existing
harness boundary. Establish the RFC's shared fact and safe-message contract
through this working CLI route so later browser and worker slices can reuse it.

## Acceptance criteria

- [ ] A command with HCN equal to the release pin emits no drift warning. A known differing version that passes the existing floor emits a warning and preserves execution and exit behavior. A floor failure remains an error and suppresses a redundant drift warning.
- [ ] Pin identity follows the RFC's whitespace/leading-v normalization and complete SemVer syntax, including prerelease and build metadata. Malformed version output is unknown for diagnostic equality; it never becomes a verified match or changes the existing floor result.
- [ ] The pin comes from the running Lucid release in both package and compiled forms, even when invoked beside another checkout. It is distinct from the minimum admitted version.
- [ ] Resolution and invocation identify the same executable. All six resolver sources carry the correct available path and lookup root, with repair advice for that installation. Only the resolved Lucid package dependency is described as Lucid's supplied HCN; unknown ownership remains unknown.
- [ ] Common diagnostic facts support the RFC's codes, scope, severity, operation, origin, observation time, HCN facts, and nullable harness facts. Known structured refusal facts survive without matching English error text.
- [ ] CLI initialization messages include the affected operation, known detected/required versions, installation provenance, manual repair, and owning-runtime restart. They do not claim an available update exists without evidence.
- [ ] Facts and messages are shape-validated, bounded, stripped of terminal controls, and rendered as plain text. Raw stderr, invocation arguments, configuration, credentials, and native session identifiers are not forwarded. Unstructured failures use a safe inspection-unavailable explanation.
- [ ] Deterministic fake-process tests and CLI demonstrations cover match, drift, floor failure, malformed output, missing executable, and each resolution source. Package and compiled-distribution checks prove that the reported pin and executable belong to the running installation.
- [ ] Current driver and installation documentation describes this behavior and corrects stale current-pin claims while retaining historical capability-introduction versions. Repository check, build, and whitespace gates pass.
