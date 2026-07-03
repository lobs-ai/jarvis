#!/bin/bash
# jarvis STT sidecar — whisper.cpp server, OpenAI-compatible transcription API
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${STT_PORT:-7423}"
MODEL="$DIR/models/ggml-base.en.bin"
BIN="$DIR/whisper.cpp/build/bin/whisper-server"

[ -f "$BIN" ] || { echo "whisper-server missing — run: make -C $DIR"; exit 1; }
[ -f "$MODEL" ] || { echo "model missing — run: make -C $DIR model"; exit 1; }

exec "$BIN" \
  --model "$MODEL" \
  --host 127.0.0.1 \
  --port "$PORT" \
  --inference-path /v1/audio/transcriptions \
  --convert
