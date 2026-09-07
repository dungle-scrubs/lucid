# Generate stable short conversation titles

Status: open
Blocked by: 02
GitHub: [Generate stable short conversation titles](https://github.com/dungle-scrubs/lucid-v2/issues/207)

## What to build

Show a useful title immediately after the first prompt, generate it once using the selected model, and let the person rename it. Every displayed or newly saved conversation title has seven words or fewer.

## Acceptance criteria

- [ ] One shared Unicode word validator enforces one to seven words and the character bound for generated, fallback, and manual titles. Empty and attachment-only cases use the specified short labels.
- [ ] Legacy listing computes a fallback without writing. Submission persists the naming source and initial revision; later topic, model, and configuration changes never regenerate a finished title.
- [ ] A separate worker-owned naming job uses hcn without the working native session or file/shell tools. Implement and verify the required hcn isolation capability where missing; unsupported isolation retains the fallback.
- [ ] Unresolved settings defer naming without consuming an attempt. Persist consumption before launch, allow only one repair of invalid output, and keep the fallback after failure or exhausted attempts.
- [ ] Manual rename uses locked revision checks and always wins over a late generated result. Naming neither delays nor appears as the requested assistant turn.
- [ ] Prove title bounds, no model on open, bounded restart attempts, naming failure, deferred settings, and manual-rename races deterministically. Verify the hub rename interaction and pass repository checks.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.
