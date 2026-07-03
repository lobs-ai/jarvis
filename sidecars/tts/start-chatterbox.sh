#!/bin/bash
# Optional Chatterbox path (zero-shot voice cloning; ~30s/sentence on M3 Pro).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${CHATTERBOX_PORT:-7425}"
mkdir -p "$DIR/voices"
cd "$DIR"
exec .venv/bin/python server-chatterbox.py --host 127.0.0.1 --port "$PORT"
