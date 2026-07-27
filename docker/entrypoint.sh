#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
SCREEN_GEOMETRY="${SCREEN_GEOMETRY:-1440x1000x24}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

mkdir -p \
  "$HOME/.agentify-desktop" \
  /workspace/input \
  /workspace/output \
  /workspace/config

Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

cleanup() {
  kill "$NOVNC_PID" "$X11VNC_PID" "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

x11vnc \
  -display "$DISPLAY" \
  -forever \
  -shared \
  -nopw \
  -rfbport 5900 \
  -quiet >/tmp/x11vnc.log 2>&1 &
X11VNC_PID=$!

websockify \
  --web=/usr/share/novnc/ \
  "$NOVNC_PORT"   localhost:5900 >/tmp/novnc.log 2>&1 &
NOVNC_PID=$!

echo "Browser desktop: http://localhost:${NOVNC_PORT}/vnc.html"
echo "Run state: $HOME/.agentify-desktop"

exec "$@"
