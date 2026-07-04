import { z } from "zod";

// Exhibit content is by-reference (ref schemes: wiki:, img:, tool:) or inline payload.
// At M0, before any MCP server exists, inline payload is the only path.
export const ExhibitRef = z
  .string()
  .regex(/^(wiki|img|tool):.+$/, "ref must be scheme:path (wiki:|img:|tool:)");

export const Exhibit = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("markdown"),
    title: z.string().optional(),
    ref: ExhibitRef.optional(),
    body: z.string().optional(),
  }),
  z.object({
    type: z.literal("code"),
    title: z.string().optional(),
    lang: z.string().optional(),
    ref: ExhibitRef.optional(),
    body: z.string().optional(),
  }),
  z.object({
    type: z.literal("diff"),
    title: z.string().optional(),
    ref: ExhibitRef.optional(),
    body: z.string().optional(),
  }),
  z.object({
    type: z.literal("image"),
    title: z.string().optional(),
    ref: ExhibitRef.optional(),
    src: z.string().optional(),
  }),
]);
export type Exhibit = z.infer<typeof Exhibit>;

export const RiskClass = z.enum(["read", "navigate", "mutate"]);
export type RiskClass = z.infer<typeof RiskClass>;

// The queue's unit of playback. seq is minted by the compiler, strictly increasing
// within a turn; the stage plays say-items in seq order regardless of TTS completion order.
export const PerformanceItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("say"),
    seq: z.number().int().nonnegative(),
    turnId: z.string(),
    text: z.string(), // authored text: caption verbatim; TTS input may differ (pronunciation map)
  }),
  z.object({
    kind: z.literal("show"),
    seq: z.number().int().nonnegative(),
    turnId: z.string(),
    id: z.string(), // model-minted, unique within turn; stage namespaces by turn
    exhibit: Exhibit,
  }),
  z.object({
    kind: z.literal("update"),
    seq: z.number().int().nonnegative(),
    turnId: z.string(),
    ref: z.string(),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("dismiss"),
    seq: z.number().int().nonnegative(),
    turnId: z.string(),
    ref: z.string(), // exhibit id or "all"
  }),
  // Maximize an exhibit into the stage lightbox (ref "none" restores). zoom is
  // an optional magnification; Rafe can also zoom/pan by hand — last input wins.
  z.object({
    kind: z.literal("focus"),
    seq: z.number().int().nonnegative(),
    turnId: z.string(),
    ref: z.string(), // exhibit id, or "none" to close the lightbox
    zoom: z.number().positive().max(8).optional(),
  }),
  z.object({
    kind: z.literal("act"),
    seq: z.number().int().nonnegative(),
    turnId: z.string(),
    tool: z.string(),
    args: z.record(z.unknown()),
    risk: RiskClass,
  }),
]);
export type PerformanceItem = z.infer<typeof PerformanceItem>;
