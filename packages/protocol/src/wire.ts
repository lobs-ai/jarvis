import { z } from "zod";
import { PerformanceItem } from "./performance.js";
import { ActivityEvent, LiveExhibit } from "./activity.js";

// Runtime-adjustable settings, shared by the stage UI, jarvisd's HTTP control
// endpoints, and the settings MCP server — one schema, one writer (jarvisd).
// The five named levels are the Claude CLI's own --effort strings; "off" is
// ours (MAX_THINKING_TOKENS=0), the voice-latency mode.
export const ThinkingLevel = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

export const SettingsPatch = z.object({
  wiki_dir: z.string().min(1).optional(),
  model_tier1: z.string().min(1).optional(),
  model_tier2: z.string().min(1).optional(),
  thinking: ThinkingLevel.optional(),
  thinking_tier2: ThinkingLevel.optional(),
  // wake word for presence mode + its quick on/off switch (the stage footer
  // control flips wake_enabled; the word itself is set in the drawer)
  wake_word: z.string().optional(),
  wake_enabled: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const SettingsSnapshot = z.object({
  wiki_dir: z.string(),
  model_tier1: z.string(),
  model_tier2: z.string(),
  thinking: ThinkingLevel,
  thinking_tier2: ThinkingLevel,
  wake_word: z.string(),
  wake_enabled: z.boolean(),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

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
  // drop the brain's conversation history and start fresh
  z.object({ type: z.literal("session.new") }),
  z.object({ type: z.literal("settings.get") }),
  z.object({ type: z.literal("settings.set"), patch: SettingsPatch }),
  // human-facing subagent controls from the activity panel (design §II.5)
  z.object({ type: z.literal("subagent.send"), id: z.string(), message: z.string().min(1) }),
  z.object({ type: z.literal("subagent.stop"), id: z.string() }),
  // the stage noticed a performance failure (exhibit didn't resolve, audio
  // couldn't play, a directive targeted nothing) — jarvisd folds these into a
  // corrective system turn so the model can fix its own show unprompted
  z.object({
    type: z.literal("stage.fault"),
    kind: z.enum(["exhibit-unresolved", "missing-target", "audio-blocked", "audio-error"]),
    detail: z.string().min(1).max(400),
    turnId: z.string().optional(),
  }),
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
  // "system" = a turn jarvisd itself initiated (stage-fault correction)
  z.object({
    type: z.literal("turn.begin"),
    turnId: z.string(),
    source: z.enum(["voice", "text", "system"]),
  }),
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
  // conversation was reset (via UI button or settings change) — clear the room
  z.object({ type: z.literal("session.reset") }),
  // current settings; pushed on connect and after every change, whoever made it
  // (stage panel, HTTP, or Jarvis itself through the settings MCP server)
  z.object({ type: z.literal("settings"), settings: SettingsSnapshot, note: z.string().optional() }),
  // one durable activity event, live (the on-disk record IS the wire payload)
  z.object({ type: z.literal("activity"), event: ActivityEvent }),
  // replay-on-connect (Layer 2): pushed to the NEW socket only. Live exhibits
  // of completed turns (the in-flight turn arrives via the normal stream) plus
  // a bounded activity tail for caption/activity backfill. Never carries audio.
  z.object({
    type: z.literal("session.replay"),
    sessionId: z.string(),
    exhibits: z.array(LiveExhibit),
    activityTail: z.array(ActivityEvent),
    quiet: z.boolean(),
  }),
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
