# 13: Use current native settings for continuation

Status: claimed
Blocked by: none

## What to build

The public HCN inspector accounts for native settings updates after a turn and retains explicit reviewer authority, so continuation cannot use older permission decisions.

## Acceptance criteria

- [ ] Latest supported native settings events supersede prior turns for model, effort, provider and permissions.
- [ ] Missing, malformed, mismatched or unsupported authority cannot fall back to older grants.
- [ ] Reviewer selection follows verified native persistence rules and never defaults unknown authority to user.
- [ ] Public CLI tests, full upstream gates and the disposable native reproduction pass.

## Parent

RFC 27 v2, extending RFC 26 and ticket 08. Machine-made slicing under Kevin's autonomous implementation instruction. Local tracker only.
