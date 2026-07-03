import type { PerformanceItem } from "@jarvis/protocol";

// Minimal structural interface; @jarvis/voice's ChatterboxTts satisfies it.
export interface TtsLike {
  // returns 24kHz mono PCM16 bytes for the given text
  synthesize(text: string): Promise<Uint8Array>;
}

export interface QueueSink {
  sendItem(item: PerformanceItem): void;
  sendAudio(turnId: string, seq: number, pcm: Uint8Array): void;
  sendWarning(message: string): void;
}

export interface QueueOptions {
  turnId: string;
  tts: TtsLike | null; // null = M0 / quiet mode: captions only, no audio pacing
  sink: QueueSink;
  lookahead?: number; // TTS segments generated ahead of the playhead
  // pronunciation substitutions applied to TTS input only (captions keep authored text)
  ttsTextTransform?: (text: string) => string;
}

// Sequence-numbered, strict in-order playback. Lookahead pays off because
// playback of N usually outlasts generation of N+1 — the local TTS server
// serializes generation, so deeper lookahead buys queueing, not parallelism.
export class PerformanceQueue {
  private items: PerformanceItem[] = [];
  private ttsJobs = new Map<number, Promise<Uint8Array | null>>();
  private playhead = 0; // index into items
  private acks = new Map<number, () => void>();
  private ended = false;
  private interrupted = false;
  private pumping = false;
  private donePromise: Promise<void>;
  private resolveDone!: () => void;

  // What was actually performed, for barge-in history truncation.
  readonly performed: PerformanceItem[] = [];

  constructor(private readonly opts: QueueOptions) {
    this.donePromise = new Promise((r) => (this.resolveDone = r));
  }

  enqueue(item: PerformanceItem): void {
    if (this.interrupted) return;
    this.items.push(item);
    this.prefetchTts();
    void this.pump();
  }

  endOfItems(): void {
    this.ended = true;
    void this.pump();
  }

  // stage reports a say item finished playing
  ack(seq: number): void {
    this.acks.get(seq)?.();
    this.acks.delete(seq);
  }

  // Pause + flush. Returns the performed prefix for history truncation.
  interrupt(): PerformanceItem[] {
    this.interrupted = true;
    for (const resolve of this.acks.values()) resolve();
    this.acks.clear();
    this.resolveDone();
    return this.performed;
  }

  whenDone(): Promise<void> {
    return this.donePromise;
  }

  private prefetchTts(): void {
    const { tts, lookahead = 2 } = this.opts;
    if (!tts) return;
    let ahead = 0;
    for (let i = this.playhead; i < this.items.length && ahead < 1 + lookahead; i++) {
      const item = this.items[i]!;
      if (item.kind !== "say") continue;
      ahead++;
      if (!this.ttsJobs.has(item.seq)) {
        const text = this.opts.ttsTextTransform?.(item.text) ?? item.text;
        this.ttsJobs.set(
          item.seq,
          tts.synthesize(text).catch((err: unknown) => {
            this.opts.sink.sendWarning(`tts failed for segment ${item.seq}: ${String(err)}`);
            return null; // captions carry the turn (design: Failure UX)
          }),
        );
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.interrupted) {
        if (this.playhead >= this.items.length) {
          if (this.ended) break;
          return; // more items may arrive; pump re-entered on enqueue/end
        }
        const item = this.items[this.playhead]!;
        await this.play(item);
        if (this.interrupted) return;
        this.performed.push(item);
        this.playhead++;
        this.prefetchTts();
      }
      this.resolveDone();
    } finally {
      this.pumping = false;
      // handle items that arrived while we were finishing up
      if (!this.interrupted && this.playhead < this.items.length) void this.pump();
    }
  }

  private async play(item: PerformanceItem): Promise<void> {
    const { sink, tts } = this.opts;
    if (item.kind === "say" && tts) {
      const pcm = await this.ttsJobs.get(item.seq)!;
      if (this.interrupted) return;
      sink.sendItem(item);
      if (pcm && pcm.byteLength > 0) {
        sink.sendAudio(item.turnId, item.seq, pcm);
        // wait until the stage reports playback finished (or interrupt)
        await new Promise<void>((resolve) => this.acks.set(item.seq, resolve));
      }
      return;
    }
    // No-audio say (M0/quiet), and all directives: deliver immediately.
    sink.sendItem(item);
  }
}
