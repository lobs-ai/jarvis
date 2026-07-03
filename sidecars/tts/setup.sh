#!/bin/bash
# One-time TTS setup: Kokoro (default) + Chatterbox (optional cloning path).
# Python 3.11 pinned (chatterbox dep chain); setuptools<81 pinned (perth needs
# pkg_resources — see Appendix A of the design doc).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -c "import perth; assert perth.PerthImplicitWatermarker is not None, 'perth watermarker still None — setuptools pin failed'; print('✓ perth watermarker ok')"
# Kokoro model files (~310MB total)
[ -f kokoro-v1.0.onnx ] || curl -sL -o kokoro-v1.0.onnx \
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
[ -f voices-v1.0.bin ] || curl -sL -o voices-v1.0.bin \
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
echo "✓ tts setup complete"
