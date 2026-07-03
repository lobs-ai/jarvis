# jarvis

Always-on voice presence. Design of record: [docs/design/jarvis.md](docs/design/jarvis.md).
Overview: [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

**Model files are not in the repo** — the STT/TTS binaries (whisper models, CoreML
encoder, Kokoro ONNX + voices) are large and git-ignored. On a fresh clone, run the
steps in **[setup.md](setup.md)** before starting, or STT/TTS won't come up.

## Run — everything goes through `bin/jarvis`

```sh
bin/jarvis start [--build]   # start (sidecars auto-start if their assets exist)
bin/jarvis stop
bin/jarvis restart           # stop + rebuild + start
bin/jarvis status
bin/jarvis dev               # vite HMR + jarvisd watch
```
