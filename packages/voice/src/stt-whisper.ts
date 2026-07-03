import type { SttPort } from "./ports.js";

// Local whisper.cpp server adapter (OpenAI-compatible transcription endpoint).
// Note (design §Voice ports): the server decodes the WHOLE utterance after
// endpointing — latency scales with utterance length. Chunked incremental
// transcription is the designated upgrade if long utterances hurt.
export class WhisperStt implements SttPort {
  constructor(private readonly baseUrl: string) {}

  async transcribe(pcm: Uint8Array): Promise<string> {
    const wav = pcm16ToWav(pcm, 16000);
    const form = new FormData();
    form.append("file", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "utterance.wav");
    form.append("response_format", "json");
    const res = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`stt http ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const dv = new DataView(header);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}
