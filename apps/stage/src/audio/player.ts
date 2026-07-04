// In-order playback of 24 kHz PCM16 TTS segments. The queue in jarvisd already
// enforces seq order; this player just plays what arrives, one at a time, and
// acks each segment so the daemon can pace the performance.
//
// Layer 4 additions:
// - a GainNode in the output path, so barge-in can DUCK (cheap, reversible)
//   before it commits to a flush (expensive, irreversible) — §6.2's two stages.
// - the loopback-RTCPeerConnection AEC experiment: routing TTS through a peer
//   connection presents it to the browser's echo canceller as the FAR-END
//   reference, so an open mic hears Rafe, not Jarvis. This is the one genuinely
//   uncertain piece (COOP/COEP, autoplay policy) — it self-tests at arm() and
//   falls back to direct output; callers must check `aecActive` and keep
//   half-duplex behavior when it's false.

const DUCK_GAIN = 0.12;

export class Player {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private queue: Array<{ turnId: string; seq: number; pcm: Uint8Array }> = [];
  private playing = false;
  private ducked = false;
  private currentSource: AudioBufferSourceNode | null = null;

  private aec = false;
  // pinned so the peer connections aren't garbage-collected mid-session
  private aecPcs: RTCPeerConnection[] = [];
  private aecEl: HTMLAudioElement | null = null;

  private reportedUnarmed = false;

  constructor(
    private readonly onSegmentDone: (turnId: string, seq: number) => void,
    private readonly onPlayingChange: (playing: boolean) => void,
    // audio that cannot play (unarmed context, decode failure) feeds the
    // stage-fault loop — "his speech didn't play" should reach the model
    private readonly onFault?: (
      kind: "audio-blocked" | "audio-error",
      detail: string,
      turnId: string,
    ) => void,
  ) {}

  // Must be called from a user gesture at least once (browser autoplay policy);
  // the mic toggle / orb tap is that gesture — which also covers the AEC audio
  // element's play().
  arm(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      void this.tryAec();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    this.reportedUnarmed = false;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get aecActive(): boolean {
    return this.aec;
  }

  enqueue(turnId: string, seq: number, pcm: Uint8Array): void {
    if (!this.ctx && !this.reportedUnarmed) {
      // audio arrived but this tab has never armed playback (no user gesture):
      // nothing will sound until Rafe interacts. Say so once, not per segment.
      this.reportedUnarmed = true;
      this.onFault?.(
        "audio-blocked",
        "TTS audio arrived but playback isn't armed in this tab (no user gesture yet) — speech is not being heard",
        turnId,
      );
    }
    this.queue.push({ turnId, seq, pcm });
    void this.pump();
  }

  // Barge-in commit: stop now, drop everything queued.
  flush(): void {
    this.queue = [];
    try {
      this.currentSource?.stop();
    } catch {
      /* already stopped */
    }
    this.currentSource = null;
    this.unduck();
    this.setPlaying(false);
  }

  // §6.2 stage one: on the first voice-like energy, drop the volume sharply —
  // don't stop. Rafe never fights to talk over Jarvis, and a cough costs nothing.
  duck(): void {
    if (!this.gain || !this.ctx || this.ducked) return;
    this.ducked = true;
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setTargetAtTime(DUCK_GAIN, this.ctx.currentTime, 0.02);
  }

  unduck(): void {
    if (!this.gain || !this.ctx || !this.ducked) return;
    this.ducked = false;
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.setTargetAtTime(1, this.ctx.currentTime, 0.04);
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
    try {
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
      const buffer = this.ctx.createBuffer(1, samples.length, 24000);
      const ch = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) ch[i] = samples[i]! / 32768;

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain ?? this.ctx.destination);
      this.currentSource = src;
      src.onended = () => {
        this.currentSource = null;
        this.setPlaying(false);
        this.onSegmentDone(turnId, seq);
        void this.pump();
      };
      src.start();
    } catch (err) {
      // a segment that can't decode/play must not wedge the queue
      this.currentSource = null;
      this.setPlaying(false);
      this.onFault?.("audio-error", `segment ${seq} failed to play: ${String(err).slice(0, 160)}`, turnId);
      void this.pump();
    }
  }

  // Loopback AEC: player output → MediaStreamDestination → RTCPeerConnection A
  // → B → remote track → <audio> element. Chrome includes audio played through
  // a peer connection in the AEC far-end reference, so getUserMedia's
  // echoCancellation can subtract our own TTS from the mic.
  private async tryAec(): Promise<void> {
    if (!this.ctx || !this.gain) return;
    try {
      const dst = this.ctx.createMediaStreamDestination();
      const pcA = new RTCPeerConnection();
      const pcB = new RTCPeerConnection();
      this.aecPcs = [pcA, pcB];
      pcA.onicecandidate = (e) => e.candidate && void pcB.addIceCandidate(e.candidate).catch(() => {});
      pcB.onicecandidate = (e) => e.candidate && void pcA.addIceCandidate(e.candidate).catch(() => {});

      const remote = new Promise<MediaStream>((resolve, reject) => {
        const bail = setTimeout(() => reject(new Error("loopback track timeout")), 3000);
        pcB.ontrack = (e) => {
          clearTimeout(bail);
          resolve(new MediaStream([e.track]));
        };
      });
      for (const track of dst.stream.getTracks()) pcA.addTrack(track, dst.stream);

      const offer = await pcA.createOffer();
      await pcA.setLocalDescription(offer);
      await pcB.setRemoteDescription(offer);
      const answer = await pcB.createAnswer();
      await pcB.setLocalDescription(answer);
      await pcA.setRemoteDescription(answer);

      const stream = await remote;
      const el = new Audio();
      el.srcObject = stream;
      el.autoplay = true;
      await el.play();
      this.aecEl = el;

      // reroute: gain now feeds the loopback instead of the speakers directly
      this.gain.disconnect();
      this.gain.connect(dst);
      this.aec = true;
      console.log("[player] loopback AEC active — full-duplex barge-in enabled");
    } catch (err) {
      // Fallback is by design: half-duplex + headphones + tap-to-interrupt.
      this.aec = false;
      for (const pc of this.aecPcs) {
        try {
          pc.close();
        } catch {
          /* best-effort */
        }
      }
      this.aecPcs = [];
      this.aecEl = null;
      console.log(`[player] loopback AEC unavailable (${String(err)}) — staying half-duplex`);
    }
  }
}
