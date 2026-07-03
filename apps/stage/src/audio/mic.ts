// Greenfield mic capture (no browser ancestor exists — design §Voice ports):
// getUserMedia → lowpass biquad (anti-alias) → AudioWorklet tap → linear
// resample to 16 kHz → PCM16 frames upstream. The mic switch turns capture on
// and off; the endpointer downstream decides what becomes an utterance.

const WORKLET_JS = `
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("mic-tap", MicTap);
`;

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private capturing = false;
  private resampleCarry = 0;

  constructor(private readonly onPcmFrame: (pcm: Uint8Array) => void) {}

  async arm(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, // helps for calls; NOT trusted for our own TTS (design §Duplex)
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.ctx = new AudioContext();
    // autoplay policy can hand out a suspended context even after a gesture;
    // a suspended context runs the worklet never — i.e. silent blank capture
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET_JS], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);

    const source = this.ctx.createMediaStreamSource(this.stream);
    const lowpass = this.ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 7000; // anti-alias before 16 kHz resample
    this.node = new AudioWorkletNode(this.ctx, "mic-tap");
    source.connect(lowpass).connect(this.node);

    this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (!this.capturing || !this.ctx) return;
      const pcm = this.resampleTo16k(ev.data, this.ctx.sampleRate);
      if (pcm.byteLength > 0) this.onPcmFrame(pcm);
    };
  }

  get isArmed(): boolean {
    return this.ctx !== null;
  }

  begin(): void {
    this.resampleCarry = 0;
    this.capturing = true;
    // belt-and-suspenders: never capture from a suspended context
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  end(): void {
    this.capturing = false;
  }

  private resampleTo16k(input: Float32Array, inputRate: number): Uint8Array {
    const ratio = inputRate / 16000;
    const outLen = Math.floor((input.length - this.resampleCarry) / ratio);
    const out = new Int16Array(Math.max(0, outLen));
    let pos = this.resampleCarry;
    for (let i = 0; i < out.length; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] ?? 0;
      const b = input[idx + 1] ?? a;
      const sample = a + (b - a) * frac; // linear interp (lowpass upstream handles aliasing)
      out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      pos += ratio;
    }
    // fractional read offset into the NEXT frame; clamp — a negative carry
    // would index before the buffer and inject zero samples at frame seams
    this.resampleCarry = Math.max(0, pos - input.length);
    return new Uint8Array(out.buffer);
  }
}
