// In-order playback of 24 kHz PCM16 TTS segments. The queue in jarvisd already
// enforces seq order; this player just plays what arrives, one at a time, and
// acks each segment so the daemon can pace the performance.

export class Player {
  private ctx: AudioContext | null = null;
  private queue: Array<{ turnId: string; seq: number; pcm: Uint8Array }> = [];
  private playing = false;
  private currentSource: AudioBufferSourceNode | null = null;

  constructor(
    private readonly onSegmentDone: (turnId: string, seq: number) => void,
    private readonly onPlayingChange: (playing: boolean) => void,
  ) {}

  // Must be called from a user gesture at least once (browser autoplay policy);
  // the orb's tap-to-wake is that gesture.
  arm(): void {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: 24000 });
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  enqueue(turnId: string, seq: number, pcm: Uint8Array): void {
    this.queue.push({ turnId, seq, pcm });
    void this.pump();
  }

  // Barge-in: stop now, drop everything queued.
  flush(): void {
    this.queue = [];
    try {
      this.currentSource?.stop();
    } catch {
      /* already stopped */
    }
    this.currentSource = null;
    this.setPlaying(false);
  }

  private setPlaying(p: boolean): void {
    if (this.playing !== p) {
      this.playing = p;
      this.onPlayingChange(p);
    }
  }

  private async pump(): Promise<void> {
    if (this.playing || !this.ctx) return;
    const next = this.queue.shift();
    if (!next) return;
    this.setPlaying(true);

    const { turnId, seq, pcm } = next;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    const buffer = this.ctx.createBuffer(1, samples.length, 24000);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i]! / 32768;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    this.currentSource = src;
    src.onended = () => {
      this.currentSource = null;
      this.setPlaying(false);
      this.onSegmentDone(turnId, seq);
      void this.pump();
    };
    src.start();
  }
}
