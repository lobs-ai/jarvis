"""
lobs-voice-tts — Chatterbox TTS server with OpenAI-compatible API.

Endpoints:
  GET  /health                → service health + model info
  POST /v1/audio/speech       → text → audio generation
  GET  /v1/voices             → list available voices
  POST /v1/voices             → upload a reference voice for cloning
"""

import argparse
import io
import logging
import struct
import time
import wave
from pathlib import Path
from typing import Optional

import torch
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("lobs-voice-tts")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
VOICES_DIR = BASE_DIR / "voices"
VOICES_DIR.mkdir(exist_ok=True)

# ---------------------------------------------------------------------------
# Device detection
# ---------------------------------------------------------------------------
device: str = "mps" if torch.backends.mps.is_available() else "cpu"
logger.info("Detected device: %s", device)

# ---------------------------------------------------------------------------
# Global model reference (loaded on startup)
# ---------------------------------------------------------------------------
model = None  # ChatterboxTTS — set in lifespan

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="lobs-voice-tts", version="1.0.0")

# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def _load_model() -> None:
    global model
    from chatterbox.tts import ChatterboxTTS

    logger.info("Loading Chatterbox model on device=%s …", device)
    t0 = time.perf_counter()
    model = ChatterboxTTS.from_pretrained(device=device)
    elapsed = time.perf_counter() - t0
    logger.info("Model loaded in %.2fs", elapsed)


@app.on_event("shutdown")
async def _unload_model() -> None:
    global model
    logger.info("Shutting down — releasing model")
    model = None
    if device == "mps":
        torch.mps.empty_cache()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _list_voice_ids() -> list[str]:
    """Return sorted list of voice IDs available in the voices directory."""
    return sorted(p.stem for p in VOICES_DIR.glob("*.wav"))


def _resolve_voice_path(voice: str) -> Optional[Path]:
    """Resolve a voice name to a WAV file path, or None for the default voice."""
    if voice in ("default", "alloy", ""):
        return None

    path = VOICES_DIR / f"{voice}.wav"
    if not path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Voice '{voice}' not found. Available: {_list_voice_ids()}",
        )
    return path


SAMPLE_RATE = 24_000  # Chatterbox outputs 24 kHz audio

def _tensor_to_wav_bytes(wav_tensor: torch.Tensor) -> bytes:
    """Convert a (1, N) or (N,) float tensor to WAV bytes at 24 kHz."""
    if wav_tensor.dim() == 1:
        wav_tensor = wav_tensor.unsqueeze(0)
    wav_tensor = wav_tensor.detach().cpu()

    # Convert float [-1, 1] → int16 PCM
    pcm = (wav_tensor * 32767).clamp(-32768, 32767).to(torch.int16)
    pcm_bytes = pcm.numpy().tobytes()

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)
    buf.seek(0)
    return buf.read()


def _tensor_to_pcm_bytes(wav_tensor: torch.Tensor) -> bytes:
    """Convert a float tensor to raw PCM16 bytes at 24 kHz."""
    if wav_tensor.dim() == 1:
        wav_tensor = wav_tensor.unsqueeze(0)
    wav_tensor = wav_tensor.detach().cpu()

    # Clamp and convert float [-1, 1] → int16
    pcm = (wav_tensor * 32767).clamp(-32768, 32767).to(torch.int16)
    return pcm.numpy().tobytes()

# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class SpeechRequest(BaseModel):
    model: str = "chatterbox"
    input: str
    voice: str = "default"
    response_format: str = Field(default="wav", pattern="^(wav|pcm)$")
    speed: float = Field(default=1.0, ge=0.25, le=4.0)


class VoiceInfo(BaseModel):
    id: str
    name: str


class VoiceListResponse(BaseModel):
    voices: list[VoiceInfo]


class VoiceUploadResponse(BaseModel):
    id: str
    path: str


class HealthResponse(BaseModel):
    status: str
    model: str
    device: str
    voices: int

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok" if model is not None else "loading",
        model="chatterbox",
        device=device,
        voices=len(_list_voice_ids()),
    )


@app.post("/v1/audio/speech")
async def create_speech(req: SpeechRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Model is still loading")

    if not req.input or not req.input.strip():
        raise HTTPException(status_code=400, detail="'input' must be non-empty text")

    voice_path = _resolve_voice_path(req.voice)

    logger.info(
        "Generating speech: voice=%s format=%s len=%d chars",
        req.voice,
        req.response_format,
        len(req.input),
    )

    t0 = time.perf_counter()
    audio_prompt = str(voice_path) if voice_path is not None else None

    # Retry once on failure — MPS can get stale after idle time (Broken pipe, etc.)
    last_exc = None
    for attempt in range(2):
        try:
            wav_tensor = model.generate(
                text=req.input,
                audio_prompt_path=audio_prompt,
            )
            last_exc = None
            break
        except Exception as exc:
            last_exc = exc
            if attempt == 0:
                logger.warning("Generation failed (attempt 1), retrying: %s", exc)
                # Clear MPS cache and retry
                if device == "mps":
                    torch.mps.empty_cache()
            else:
                logger.exception("Generation failed after retry")

    if last_exc is not None:
        raise HTTPException(status_code=500, detail=f"Generation failed: {last_exc}")

    elapsed = time.perf_counter() - t0
    logger.info("Generated in %.3fs", elapsed)

    if req.response_format == "pcm":
        audio_bytes = _tensor_to_pcm_bytes(wav_tensor)
        return Response(
            content=audio_bytes,
            media_type="audio/pcm",
            headers={
                "X-Sample-Rate": str(SAMPLE_RATE),
                "X-Channels": "1",
                "X-Bits-Per-Sample": "16",
            },
        )

    # Default: WAV
    audio_bytes = _tensor_to_wav_bytes(wav_tensor)
    return Response(content=audio_bytes, media_type="audio/wav")


@app.get("/v1/voices", response_model=VoiceListResponse)
async def list_voices():
    ids = _list_voice_ids()
    return VoiceListResponse(
        voices=[VoiceInfo(id=v, name=v) for v in ids],
    )


@app.post("/v1/voices", response_model=VoiceUploadResponse)
async def upload_voice(
    file: UploadFile = File(..., description="Reference WAV file (5-15s of speech)"),
    name: str = Form(..., description="Voice identifier (alphanumeric + hyphens)"),
):
    # Validate name
    safe_name = name.strip().lower()
    if not safe_name or not all(c.isalnum() or c in "-_" for c in safe_name):
        raise HTTPException(
            status_code=400,
            detail="Voice name must be alphanumeric (hyphens and underscores allowed)",
        )

    if safe_name == "default":
        raise HTTPException(status_code=400, detail="Cannot overwrite the default voice")

    # Validate file type
    if file.content_type and file.content_type not in (
        "audio/wav",
        "audio/wave",
        "audio/x-wav",
        "application/octet-stream",
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Expected WAV file, got {file.content_type}",
        )

    dest = VOICES_DIR / f"{safe_name}.wav"
    contents = await file.read()

    if len(contents) < 1000:
        raise HTTPException(status_code=400, detail="File too small — need 5-15s of speech audio")

    dest.write_bytes(contents)
    logger.info("Saved voice '%s' (%d bytes) → %s", safe_name, len(contents), dest)

    return VoiceUploadResponse(id=safe_name, path=str(dest.relative_to(BASE_DIR)))

# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="lobs-voice-tts — Chatterbox TTS server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=7422, help="Port (default: 7422)")
    parser.add_argument("--log-level", default="info", help="Log level (default: info)")
    args = parser.parse_args()

    logger.info("Starting lobs-voice-tts on %s:%d (device=%s)", args.host, args.port, device)

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        access_log=True,
    )


if __name__ == "__main__":
    main()
