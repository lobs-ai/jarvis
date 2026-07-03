// Swappable by design (design §Voice ports): local adapters today, hosted
// adapters behind the same interfaces if M1 measurement demands the swap.

export interface SttPort {
  // 16 kHz mono PCM16 in, transcript out
  transcribe(pcm: Uint8Array): Promise<string>;
  healthy(): Promise<boolean>;
}

export interface TtsPort {
  // text in, 24 kHz mono PCM16 out
  synthesize(text: string): Promise<Uint8Array>;
  healthy(): Promise<boolean>;
  dispose(): void;
}
