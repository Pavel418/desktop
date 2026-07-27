#!/usr/bin/env bash
set -euo pipefail

CHROMIUM_BIN="${CHROMIUM_BIN:-/usr/bin/chromium}"

exec "$CHROMIUM_BIN" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-features=Translate,MediaRouter \
  "$@"
