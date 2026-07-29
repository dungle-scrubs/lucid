#!/usr/bin/env bash
# The R1 gate (plan 02, MD.1): a review record under `.lucid/` is committable
# only if git does not ignore it. This finds every `.lucid/*.html` artifact
# under the given roots (default: the current dir) that git still ignores, and
# names the rule doing it - the sibling-era trap the migration is meant to undo.
#
# Exits non-zero when any offender is found, so a per-repo commit step can gate
# on it: `scripts/r1-check.sh . && git add .lucid && git commit`.
#
# Usage: scripts/r1-check.sh [root ...]
set -euo pipefail

roots=("${@:-.}")
found=0

for base in "${roots[@]}"; do
  [ -d "$base" ] || continue
  while IFS= read -r ld; do
    for html in "$ld"/*.html; do
      [ -e "$html" ] || continue
      repo=$(git -C "$(dirname "$html")" rev-parse --show-toplevel 2>/dev/null) || continue
      if rule=$(git -C "$repo" check-ignore -v "$html" 2>/dev/null); then
        echo "R1 TRAP  $html  <=  $rule"
        found=1
      fi
    done
  done < <(find "$base" -type d -name .lucid 2>/dev/null)
done

if [ "$found" -eq 0 ]; then
  echo "R1 clean: no .lucid/*.html artifact is git-ignored under ${roots[*]}"
fi
exit "$found"
