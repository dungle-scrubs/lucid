# Resume native sessions consistently

Status: resolved
Blocked by: 02
GitHub: [Resume native sessions consistently](https://github.com/dungle-scrubs/lucid-v2/issues/208)

## What to build

Continue the same native session on successive headless turns and after its terminal process departs. Preserve the starting folder and selected mode, and reuse the session when the model changes within a supported harness.

## Acceptance criteria

- [x] Capture actual native IDs by harness from both interactive and headless sources, with producing participation and owner evidence. Revise the source contract and its deliberate interactive-attribution rule together.
- [x] Every supported headless turn resumes its own harness session, including second and later turns after process loss. Pass the exact saved working folder on every launch path.
- [x] A supported same-harness model change passes the new concrete model with the existing native ID. No session ID crosses harnesses and no profile is silently substituted.
- [x] A live terminal owner remains protected even when unattached. Departed interactive ownership permits headless-turn continuation with a visible mode notice after executor acquisition.
- [x] Unknown or unsupported native-resume adapters are refused explicitly. Validate selected executable compatibility and hcn rendering; keep live-model confirmation distinct from deterministic proof.
- [x] Refused native recall preserves the prompt and selected settings without automatically starting fresh or reverting to the previous model. Prove recall, cwd, identity attribution, and ownership with fake-hcn process oracles; pass repository checks.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.

## Verification

Final integration: 1,330 deterministic tests and 6,780 assertions pass, plus lint, both typechecks, binary build, behavior reference, and diff checks. Browser evidence covers 390, 768, and 1440 pixels, full-width pointer resizing, stable menu placeholder color, tab closure and reload, and explicit failure recovery. hcn 0.6.4 is published and pinned; Pi recordings were recaptured on mini. Installed Claude/Opus context inspection reports a verified native budget. These live observations supplement the deterministic gate. Review findings and process lifecycle regressions are resolved.
