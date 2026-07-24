#!/bin/sh
# Verified-secret scan, run from lefthook's pre-push hook. Scanning after a push
# is theatre - the secret is already published and must be rotated - so this runs
# locally before anything leaves the machine.

if ! command -v trufflehog >/dev/null 2>&1; then
  echo "secret-scan: trufflehog not installed, skipping." >&2
  echo "            brew install trufflehog  (https://github.com/trufflesecurity/trufflehog)" >&2
  exit 0
fi

# Scan the primary worktree rather than the current one. In a LINKED worktree
# `.git` is a file pointing at the real gitdir, which trufflehog cannot open -
# it fails to read the index and exits non-zero, which this script used to
# report as "verified secrets found". The primary worktree shares the object
# store and every branch ref, so the commits being pushed are in scope either
# way.
common=$(git rev-parse --git-common-dir)
case "$common" in
  /*) repo=$(dirname "$common") ;;
  *) repo=$(git rev-parse --show-toplevel) ;;
esac

echo "secret-scan: scanning for verified secrets..."
trufflehog git "file://$repo" --only-verified --fail --no-update
status=$?
[ "$status" -eq 0 ] && exit 0

echo >&2
# 183 is trufflehog's documented exit for "--fail, and results were found".
# Anything else means the scan did not run, and saying "secrets found" for that
# is both false and the fastest way to teach someone to pass --no-verify.
if [ "$status" -eq 183 ]; then
  echo "secret-scan: verified secrets found. Push blocked." >&2
  echo "            Rotate the credential first - removing it from the diff is not enough." >&2
else
  echo "secret-scan: the scan could not run (trufflehog exit $status). Push blocked." >&2
  echo "            Nothing was checked, so this is not a clean bill of health - fix" >&2
  echo "            the scan rather than bypassing it." >&2
fi
exit 1
