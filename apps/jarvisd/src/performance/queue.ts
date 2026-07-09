import type { PerformanceItem } from "@jarvis/protocol";

// After the last line's wall-clock pacing completes, wait this long for trailing
// played-acks before judging whether the turn was heard. The browser plays a
// beat behind the daemon's clock (send latency + onended lag, and that lag
// accumulates across a long turn), so the final acks legitimately arrive after
// the daemon has already advanced. Only bounds FAULT DETECTION, never pacing.
const ACK_GRACE_MS = 3000;

// Minimal structural interface; @jarvis/voice's ChatterboxTts satisfies it.
export interface TtsLike {
  // returns 24kHz mono PCM16 bytes for the given text
  synthesize(text: string): Promise<Uint8Array>;
}

export interface QueueSink {
  sendItem(item: PerformanceItem): void;
  sendAudio(turnId: string, seq: number, pcm: Uint8Array): void;
  sendWarning(message: string): void;
  // Is any stage tab actually connected? With no audience there is no playhead
  // to pace to, so the performance advances on its own clock instead of holding
  // the turn open waiting for acks that can never come.
  hasAudience(): boolean;
}

export interface QueueOptions {
  turnId: string;
  tts: TtsLike | null; // null = M0 / quiet mode: captions only, no audio pacing
  sink: QueueSink;
  lookahead?: number; // TTS segments generated ahead of the playhead
  // pronunciation substitutions applied to TTS input only (captions keep authored text)
  ttsTextTransform?: (text: string) => string;
  // a say segment's played-ack never arrived: audio very likely didn't play
  // (unarmed player, sleeping tab). Feeds the stage-fault loop.
  onFault?: (item: PerformanceItem) => void;
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

  // Fault detection is turn-level, not per-segment. One ack proves the stage is
  // alive and playing, so we never fault a turn that got ANY ack — a late or
  // drifted ack on a later line is playback lag, not a miss. Only a turn that
  // sent audio to a present audience and got zero acks back is a real "nothing
  // was heard" (dead tab, unarmed context), reported once.
  private ackedAny = false;
  private sentAudioSays = 0;
  private lastAudioSay: PerformanceItem | null = null;
  private faultChecked = false;

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
    this.ackedAny = true; // proof of a live, playing audience — turn can't fault
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

  // Resolves when everything enqueued so far has been performed. Used to defer
  // navigate/mutate act-tool execution until the performance catches up —
  // the model's pre-tool narration plays BEFORE the action fires (design §acts).
  async waitForDrain(): Promise<void> {
    while (!this.interrupted && this.playhead < this.items.length) {
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  get wasInterrupted(): boolean {
    return this.interrupted;
  }

  // ── interrupt-note bookkeeping (§6.3): how much of the performance the
  // audience actually got, so the model knows the scale of what was missed ──
  get totalSays(): number {
    return this.items.filter((i) => i.kind === "say").length;
  }

  get performedSays(): number {
    return this.performed.filter((i) => i.kind === "say").length;
  }

  // exhibits that were generated but never reached the stage
  unperformedShows(): Array<{ id: string; title?: string }> {
    const out: Array<{ id: string; title?: string }> = [];
    for (let i = this.playhead; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (item.kind === "show") out.push({ id: item.id, title: item.exhibit.title });
    }
    return out;
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
      this.scheduleTurnFaultCheck();
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
        // PCM16 mono @ 24kHz → real-time playback duration of this segment.
        const durationMs = (pcm.byteLength / 2 / 24_000) * 1000;
        await this.paceSay(item, durationMs);
      }
      return;
    }
    // No-audio say (M0/quiet), and all directives: deliver immediately.
    sink.sendItem(item);
  }

  // Pace the performance to the audio's OWN real-time duration, NOT to the
  // browser's played-ack. A browser tab is not a reliable clock — it can be
  // asleep, closed, or mid-reconnect (a daemon restart drops every socket) — so
  // the daemon advances on its own wall-clock and treats the ack as telemetry:
  // an ack that arrives resolves the wait a touch early (real playback ended)
  // and confirms the line was heard; an ack that never comes no longer stalls
  // the turn. This is the fix for the "crawl" — the old code waited
  // duration + grace PER segment when acks went missing, so a gone tab turned a
  // 20s answer into minutes of dead air, advancing one timeout at a time.
  private paceSay(item: PerformanceItem, durationMs: number): Promise<void> {
    this.sentAudioSays++;
    this.lastAudioSay = item;
    // Empty room: nothing is playing this, so pacing to a playhead that doesn't
    // exist only holds the turn open. Advance immediately; the end-of-turn check
    // decides whether an audience that never acked is a real fault.
    if (!this.opts.sink.hasAudience()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const paceTimer = setTimeout(resolve, durationMs);
      // The ack is telemetry: it resolves the wait a touch early when real
      // playback ends, and (via ack()) marks the turn as heard. A missing ack
      // never stalls — paceTimer already bounds the wait to the audio's length.
      this.acks.set(item.seq, () => {
        clearTimeout(paceTimer);
        this.acks.delete(item.seq);
        resolve();
      });
    });
  }

  // One tolerant, turn-level verdict after the performance drains: if we sent
  // audio to a present audience and NOTHING was ever acked, the tab is dead or
  // unarmed — nobody heard the turn — so report it once. A grace window lets the
  // trailing acks (which lag the daemon's clock) land first; a single ack, even
  // a late one, clears the whole turn. This replaces the old per-segment timers
  // that fired spurious "line wasn't acknowledged" faults on ordinary lag.
  private scheduleTurnFaultCheck(): void {
    if (this.faultChecked) return;
    this.faultChecked = true;
    if (this.sentAudioSays === 0 || this.ackedAny) return; // no audio, or already proven heard
    const timer = setTimeout(() => {
      if (this.ackedAny || this.interrupted) return; // a trailing ack proved liveness
      if (!this.opts.sink.hasAudience()) return; // empty room is not a fault
      if (this.lastAudioSay) this.opts.onFault?.(this.lastAudioSay);
    }, ACK_GRACE_MS);
    timer.unref?.();
  }
}
