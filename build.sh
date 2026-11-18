#!/bin/sh
# Builds t3+ for the desktop app from extension/ into dist/, after its tests pass.
#   sh ~/.t3plus/build.sh && node ~/.t3plus/t3plus.mjs on
set -e
cd "$(dirname "$0")/extension"
# Local folders the loader and the launchd job write to (not in git): a fresh clone
# has neither, and launchd cannot start a job whose log folder is missing.
mkdir -p ../state ../feeds
[ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error
if ! out=$(npm test 2>&1); then
  printf '%s\n' "$out" | grep -E "^not ok|^# (pass|fail)|Error|expected|actual" | head -40
  echo "t3+ build stopped: the tests failed (run 'npm test' in ~/.t3plus/extension for the full output)." >&2
  exit 1
fi
node ../build-desktop.mjs "$(pwd)"
