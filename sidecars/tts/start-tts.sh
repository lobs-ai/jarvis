#!/bin/bash
# jarvis TTS sidecar — Kokoro (fast local default). Chatterbox (voice cloning)
# is the optional slow path: start-chatterbox.sh on :7425.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${TTS_PORT:-7422}"
[ -f "$DIR/.venv/bin/python" ] || { echo "venv missing — run: $DIR/setup.sh"; exit 1; }
cd "$DIR"
exec .venv/bin/python server-kokoro.py --host 127.0.0.1 --port "$PORT"
