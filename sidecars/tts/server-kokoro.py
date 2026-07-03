"""
jarvis TTS sidecar — Kokoro (kokoro-onnx), OpenAI-compatible API.

Design note: Chatterbox measured ~30s/sentence warm on the M3 Pro (MPS) —
~0.14x realtime, unusable for conversation. Kokoro-82M via ONNX is the
designated faster local fallback (design §Voice ports); voice cloning is
deferred to the Chatterbox path (server-chatterbox.py, optional, :7425).

Endpoints (same contract the @jarvis/voice adapter expects):
  GET  /health                → {"status": "ok"}
  POST /v1/audio/speech       → wav | pcm (24 kHz mono PCM16)
"""

import argparse
import io
import logging
import time
import wave
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s — %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("jarvis-tts-kokoro")

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "kokoro-v1.0.onnx"
VOICES_PATH = BASE_DIR / "voices-v1.0.bin"

SAMPLE_RATE = 24_000
DEFAULT_VOICE = "bm_george"  # Jarvis is British

kokoro = None
app = FastAPI(title="jarvis-tts-kokoro", version="1.0.0")


@app.on_event("startup")
async def _load() -> None:
    global kokoro
    from kokoro_onnx import Kokoro

    if not MODEL_PATH.is_file() or not VOICES_PATH.is_file():
        raise RuntimeError(f"model files missing — run setup.sh (expected {MODEL_PATH.name}, {VOICES_PATH.name})")
    t0 = time.perf_counter()
    kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
    logger.info("Kokoro loaded in %.2fs", time.perf_counter() - t0)


class SpeechRequest(BaseModel):
    model: str = "kokoro"
    input: str
    voice: str = "default"
    response_format: str = Field(default="wav", pattern="^(wav|pcm)$")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.get("/health")
async def health():
    return {"status": "ok" if kokoro is not None else "loading", "model": "kokoro", "device": "onnx"}


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if kokoro is None:
        raise HTTPException(status_code=503, detail="model loading")
    if not req.input.strip():
        raise HTTPException(status_code=400, detail="'input' must be non-empty")
    voice = DEFAULT_VOICE if req.voice in ("default", "alloy", "") else req.voice

    t0 = time.perf_counter()
    try:
        samples, sr = kokoro.create(req.input, voice=voice, speed=req.speed)
    except Exception as exc:
        logger.exception("generation failed")
        raise HTTPException(status_code=500, detail=f"generation failed: {exc}") from exc
    elapsed = time.perf_counter() - t0
    logger.info("Generated %.1fs of audio in %.3fs (voice=%s)", len(samples) / sr, elapsed, voice)

    if sr != SAMPLE_RATE:
        # kokoro emits 24 kHz today; resample defensively if that ever changes
        idx = np.linspace(0, len(samples) - 1, int(len(samples) * SAMPLE_RATE / sr))
        samples = np.interp(idx, np.arange(len(samples)), samples)

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()

    if req.response_format == "pcm":
        return Response(
            content=pcm,
            media_type="audio/pcm",
            headers={"X-Sample-Rate": str(SAMPLE_RATE), "X-Channels": "1", "X-Bits-Per-Sample": "16"},
        )
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return Response(content=buf.getvalue(), media_type="audio/wav")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7422)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
