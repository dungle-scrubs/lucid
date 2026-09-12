# 13: Use current native settings for continuation

Status: resolved
Blocked by: none

## What to build

The public HCN inspector accounts for native settings updates after a turn and retains explicit reviewer authority, so continuation cannot use older permission decisions.

## Acceptance criteria

- [x] Latest supported native settings events supersede prior turns for model, effort, provider and permissions.
- [x] Missing, malformed, mismatched or unsupported authority cannot fall back to older grants.
- [x] Reviewer selection follows verified native persistence rules and never defaults unknown authority to user.
- [x] Public CLI tests, full upstream gates and the disposable native reproduction pass.

## Parent

RFC 27 v2, extending RFC 26 and ticket 08. Machine-made slicing under Kevin's autonomous implementation instruction. Local tracker only.

## Answer

HCN 63a2255 and guidance caeb464 implement the current native settings read. Native settings updates supersede prior turns, the provider follows later recorded updates, and explicit reviewer authority survives omitted turn fields without inheriting permission grants. Unknown reviewers remain unknown. Unsupported policy additions and invalid latest records refuse. The public native reproduction now reports the saved on-request policy and user reviewer. All four Muse review axes are resolved; full upstream checks pass 1,076 tests in each runtime, build/package checks, and both skill-claim checks. Evidence is in ignored native-settings-events-* artifacts. This changes passive inspection only.
