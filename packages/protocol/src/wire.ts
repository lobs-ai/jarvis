import { z } from "zod";
import { PerformanceItem } from "./performance.js";

// stage → jarvisd
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), quiet: z.boolean().default(false) }),
  z.object({ type: z.literal("text.input"), text: z.string().min(1) }),
  // PTT / VAD envelope around upstream binary mic frames
  z.object({ type: z.literal("mic.begin"), sampleRate: z.literal(16000) }),
  z.object({ type: z.literal("mic.end") }),
  z.object({ type: z.literal("mic.cancel") }),
  z.object({ type: z.literal("quiet.set"), quiet: z.boolean() }),
  // user pressed/clicked to interrupt an active performance
  z.object({ type: z.literal("interrupt") }),
  // stage finished playing a say item (drives queue pacing in M1+)
  z.object({ type: z.literal("played"), turnId: z.string(), seq: z.number().int() }),
  // click-confirm for a pending mutate act or wiki commit
  z.object({ type: z.literal("confirm"), confirmId: z.string(), approve: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const OrbState = z.enum([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "acting",
  "degraded",
]);
export type OrbState = z.infer<typeof OrbState>;

// jarvisd → stage
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), orb: OrbState }),
  z.object({ type: z.literal("turn.begin"), turnId: z.string(), source: z.enum(["voice", "text"]) }),
  z.object({ type: z.literal("turn.end"), turnId: z.string() }),
  // live transcript of what STT heard (caption rail shows user side too)
  z.object({ type: z.literal("heard"), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal("item"), item: PerformanceItem }),
  // the model's private workspace (scratch text + tool markers), surfaced as a
  // dim inner-monologue line so silent work is visibly alive — never spoken
  z.object({ type: z.literal("thought"), turnId: z.string(), text: z.string() }),
  // audio for a say item arrives as a binary frame; this announces it
  z.object({
    type: z.literal("audio.segment"),
    turnId: z.string(),
    seq: z.number().int(),
    streamId: z.number().int(),
    sampleRate: z.literal(24000),
    bytes: z.number().int(),
  }),
  z.object({
    type: z.literal("confirm.request"),
    confirmId: z.string(),
    summary: z.string(),
    detail: z.string().optional(),
    phrases: z.array(z.string()), // exact-match spoken confirmations accepted
  }),
  z.object({ type: z.literal("confirm.resolved"), confirmId: z.string(), approved: z.boolean() }),
  z.object({ type: z.literal("error"), message: z.string(), detail: z.string().optional() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// Binary WS frames, both directions:
//   8-byte header (little-endian): u32 streamId, u32 seq — then PCM16 payload.
//   mic upstream: 16 kHz mono. TTS downstream: 24 kHz mono.
export const BINARY_HEADER_BYTES = 8;

export function encodeBinaryFrame(streamId: number, seq: number, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(BINARY_HEADER_BYTES + pcm.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, streamId, true);
  dv.setUint32(4, seq, true);
  out.set(pcm, BINARY_HEADER_BYTES);
  return out;
}

export function decodeBinaryFrame(frame: ArrayBuffer): {
  streamId: number;
  seq: number;
  pcm: Uint8Array;
} {
  const dv = new DataView(frame);
  return {
    streamId: dv.getUint32(0, true),
    seq: dv.getUint32(4, true),
    pcm: new Uint8Array(frame, BINARY_HEADER_BYTES),
  };
}
