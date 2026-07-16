#!/bin/sh
# Verified-secret scan, run from lefthook's pre-push hook. Scanning after a push
# is theatre - the secret is already published and must be rotated - so this runs
# locally before anything leaves the machine.

if ! command -v trufflehog >/dev/null 2>&1; then
  echo "secret-scan: trufflehog not installed, skipping." >&2
  echo "            brew install trufflehog  (https://github.com/trufflesecurity/trufflehog)" >&2
  exit 0
fi

echo "secret-scan: scanning for verified secrets..."
if ! trufflehog git "file://$(git rev-parse --show-toplevel)" --only-verified --fail --no-update; then
  echo >&2
  echo "secret-scan: verified secrets found. Push blocked." >&2
  echo "            Rotate the credential first - removing it from the diff is not enough." >&2
  exit 1
fi

exit 0
