#!/bin/sh
# Builds t3+ for the desktop app from extension/ into dist/, after its tests pass.
#   sh ~/.t3plus/build.sh && node ~/.t3plus/t3plus.mjs on
set -e
cd "$(dirname "$0")/extension"
[ -d node_modules ] || npm ci --no-audit --no-fund --silent
npm test --silent >/dev/null
node ../build-desktop.mjs "$(pwd)"
