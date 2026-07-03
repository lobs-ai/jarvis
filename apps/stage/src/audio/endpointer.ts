// Utterance endpointing for the open-mic switch: energy-based VAD over ~30ms
// windows with a pre-roll ring so word onsets aren't clipped. Deliberately a
// detector behind a tiny event surface — Silero VAD can replace the energy
// heuristic later without touching the shell around it.

export interface EndpointerEvents {
  onUtteranceStart: () => void; // send mic.begin
  onAudio: (pcm: Uint8Array) => void; // utterance audio (pre-roll replay + live)
  onUtteranceEnd: (durMs: number) => void; // send mic.end (or mic.cancel if short)
  onLevel: (rms: number) => void; // ~every 30ms while the mic is open
}

const WINDOW_MS = 30; // decisions on 30ms windows; raw worklet frames are ~3ms
const START_RMS = 0.015; // normalized [0,1]; AGC'd speech sits ≥ ~0.03
const END_RMS = 0.008;
const START_MS = 90; // sustained speech to open an utterance
const END_MS = 800; // sustained silence to close it
const PRE_ROLL_MS = 300;
const MAX_UTTER_MS = 30_000; // hard cap — something is wrong past this

export class Endpointer {
  private win: Uint8Array[] = [];
  private winMs = 0;
  private preRoll: Uint8Array[] = [];
  private preRollMs = 0;
  private inUtterance = false;
  private speechMs = 0;
  private silenceMs = 0;
  private utterMs = 0;

  constructor(private readonly ev: EndpointerEvents) {}

  get active(): boolean {
    return this.inUtterance;
  }

  push(pcm: Uint8Array): void {
    this.win.push(pcm);
    this.winMs += msOf(pcm);
    if (this.winMs < WINDOW_MS) return;
    const window = concat(this.win);
    this.win = [];
    this.winMs = 0;
    this.process(window);
  }

  // Drop any in-flight utterance without emitting end (half-duplex gate, mic
  // off). Returns true if an utterance WAS active — caller sends mic.cancel.
  cancel(): boolean {
    const was = this.inUtterance;
    this.win = [];
    this.winMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;
    this.inUtterance = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utterMs = 0;
    return was;
  }

  private process(window: Uint8Array): void {
    const ms = msOf(window);
    const rms = rmsOf(window);
    this.ev.onLevel(rms);

    if (!this.inUtterance) {
      this.preRoll.push(window);
      this.preRollMs += ms;
      while (this.preRollMs > PRE_ROLL_MS && this.preRoll.length > 1) {
        this.preRollMs -= msOf(this.preRoll.shift()!);
      }
      if (rms >= START_RMS) {
        this.speechMs += ms;
        if (this.speechMs >= START_MS) this.start();
      } else {
        this.speechMs = Math.max(0, this.speechMs - ms);
      }
      return;
    }

    this.utterMs += ms;
    this.ev.onAudio(window);
    if (rms < END_RMS) {
      this.silenceMs += ms;
      if (this.silenceMs >= END_MS || this.utterMs >= MAX_UTTER_MS) this.end();
    } else {
      this.silenceMs = 0;
    }
  }

  private start(): void {
    this.inUtterance = true;
    this.utterMs = this.preRollMs;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.ev.onUtteranceStart();
    for (const f of this.preRoll) this.ev.onAudio(f); // replay the onset
    this.preRoll = [];
    this.preRollMs = 0;
  }

  private end(): void {
    const dur = this.utterMs;
    this.inUtterance = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utterMs = 0;
    this.ev.onUtteranceEnd(dur);
  }
}

function msOf(pcm: Uint8Array): number {
  return (pcm.byteLength / 2 / 16000) * 1000;
}

function rmsOf(pcm: Uint8Array): number {
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  if (view.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < view.length; i++) {
    const s = view[i]! / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / view.length);
}

function concat(frames: Uint8Array[]): Uint8Array {
  if (frames.length === 1) return frames[0]!;
  const total = frames.reduce((n, f) => n + f.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frames) {
    out.set(f, off);
    off += f.byteLength;
  }
  return out;
}
