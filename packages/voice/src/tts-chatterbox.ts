import type { TtsPort } from "./ports.js";

const KEEPALIVE_IDLE_MS = 240_000; // MPS goes stale after idle (Appendix A / lobs-voice logs)

// Local Chatterbox server adapter. The server blocks per request (no
// sub-sentence streaming) and serializes generation — lookahead depth beyond
// the next segment buys queueing, not parallelism (design §Performance engine).
export class ChatterboxTts implements TtsPort {
  private lastActivity = Date.now();
  private inFlight = 0;
  private keepaliveTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly baseUrl: string,
    private readonly voice: string = "default",
  ) {
    // Keepalive skipped whenever a request is in flight or recent, so it never
    // queues ahead of real speech on a serializing server (design fix M-b).
    this.keepaliveTimer = setInterval(() => {
      if (this.inFlight > 0) return;
      if (Date.now() - this.lastActivity < KEEPALIVE_IDLE_MS) return;
      void this.synthesize("ok").catch(() => {
        /* keepalive is best-effort */
      });
    }, 60_000);
  }

  async synthesize(text: string): Promise<Uint8Array> {
    this.inFlight++;
    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatterbox",
          input: text,
          voice: this.voice,
          response_format: "pcm",
        }),
      });
      if (!res.ok) throw new Error(`tts http ${res.status}: ${await res.text()}`);
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      this.inFlight--;
      this.lastActivity = Date.now();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return false;
      const json = (await res.json()) as { status?: string };
      return json.status === "ok";
    } catch {
      return false;
    }
  }

  dispose(): void {
    clearInterval(this.keepaliveTimer);
  }
}
