# jarvis

An always-on voice presence for one machine. Talk to it (or type), and it answers
**out loud while showing things on a stage in sync with its voice** — pages, code, diffs,
images appearing as it speaks — acts on your browser and terminal, and maintains a
plain-markdown, git-versioned personal wiki about you.

Built for exactly one user, on his own machines. That's a load-bearing simplification, not
an oversight: no multi-user anything, no auth beyond the OS user and a localhost binding, no
plugin system. Everything is concrete — one terminal, one Chrome, one voice, one wiki, one
conversation.

- **Design of record:** [docs/design/jarvis.md](docs/design/jarvis.md)
- **Overview:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **First-time setup (model files):** [setup.md](setup.md)

## The core idea: performances

Jarvis's unit of output is a **performance** — an ordered stream of items played in sync:

- `say` — a sentence, spoken by TTS and always shown as a caption.
- `show` / `update` / `dismiss` — an exhibit materializes on the stage (markdown, code, diff,
  image), changes, or sweeps away.
- `act` — a real-world action (navigate/click a browser tab, run a command) fires when the
  queue reaches it.

The trick that makes narration and visuals interleave in a single model generation: **stage
directives are inline text markup, not tool calls.** The model writes lightweight tags in its
streamed prose (`<show id="e1" type="markdown" ref="wiki:projects/agentd.md"/>`), and a
**compiler** parses them out of the token stream as it arrives — prose becomes `say` items,
tags become `show`/`update`/`dismiss` items at their exact position. One generation, true
interleaving, zero extra round-trips. Real MCP tool calls are reserved for informational reads
and risk-gated world-acts. See the design doc's "performance engine" section and Appendix B for
the markup spec.

## Layout

A pnpm workspace (Node ≥ 22, TypeScript).

```
apps/
  jarvisd/    the daemon — session, brain loop, performance compiler + queue,
              memory, MCP client, WS to the stage. Serves the stage on :7430.
  stage/      the web app — mic ▸ speaker, orb, exhibits, text bar, activity/wiki panels.

packages/
  protocol/   the wire shared by jarvisd and the stage (performance, context, wire types).
  voice/      swappable STT/TTS ports (whisper, chatterbox).

servers/      MCP servers — Jarvis's window onto external services:
  wiki/       single writer for the Karpathy wiki; propose/commit split, commit is confirm-gated.
  browser/    EYES read the real Chrome via AppleScript; HANDS act via CDP on a dedicated profile.
  terminal/   terminal_context reads active-shell scrollback; terminal_run executes a command.
  speech/     the `say` tool for the CLI brain (a thin ack; jarvisd performs speech from the stream).
  settings/   lets Jarvis read/change its own config through jarvisd's single-writer endpoint.

sidecars/
  stt/        whisper.cpp server (:7423), with an optional CoreML/ANE encoder for latency.
  tts/        Kokoro (:7422, fast local default) + optional Chatterbox (:7425, voice cloning).

bin/jarvis    lifecycle script (below).
```

## Setup

Model files (whisper models, CoreML encoder, Kokoro ONNX + voices) are large and git-ignored,
so a fresh clone needs a one-time setup before the voice path works. Requires `pnpm`, `cmake`,
`uv`, and macOS for the CoreML/ANE path.

```sh
pnpm install
make -C sidecars/stt && make -C sidecars/stt coreml   # STT
bash sidecars/tts/setup.sh                             # TTS
```

Full detail — paths, sizes, and what each step produces — is in **[setup.md](setup.md)**. The
sidecars are optional until their assets exist; `bin/jarvis start` runs without them (captions
only, no audio).

## Run — everything goes through `bin/jarvis`

```sh
bin/jarvis start [--build]   # start jarvisd; sidecars auto-start if their assets exist
bin/jarvis stop
bin/jarvis restart           # stop + rebuild + start
bin/jarvis status            # process + HTTP health
bin/jarvis dev               # vite HMR + jarvisd watch (ctrl-c stops both)
bin/jarvis chrome            # launch the Jarvis-owned Chrome profile (CDP :9222) for browser hands
bin/jarvis logs              # tail all logs
```

Then open the stage at **http://127.0.0.1:7430**.

### Ports

| Port | Service |
| --- | --- |
| 7430 | jarvisd — stage HTTP + WebSocket (override with `JARVIS_PORT`) |
| 7423 | STT — whisper.cpp server |
| 7422 | TTS — Kokoro (fast local default) |
| 7425 | TTS — Chatterbox (optional, zero-shot voice cloning) |
| 9222 | CDP — Jarvis-owned Chrome profile for browser hands |

## The brain (swappable)

The brain is a swappable `BrainPort`. The default is **`CliBrain`** — driven by a Claude Code
subscription, with speech performed from its event stream as the model generates. **`ApiBrain`**
runs the two-tier Messages-API path. Both feed the same performance compiler and queue.

## Status

Built leaf-to-root through the milestones in the design doc (§Milestones): M0 text spine → M1
voice → M2 wiki → M3 editor + eyes → M4 hands + tasks. The design doc's own status header
predates the implementation and is stale relative to the code — trust the code and git history
for what actually exists.
