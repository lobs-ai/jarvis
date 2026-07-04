import { z } from "zod";
import { Exhibit } from "./performance.js";

// One event, one log, three projections (post-M4 design §II.2): ActivityEvent
// is BOTH the on-disk session record (~/.jarvis/sessions/<id>.jsonl) and the
// wire payload the stage renders. The conversation view reads heard+say+exhibit,
// the activity view reads everything, and the reconnect replay reads the
// live-exhibit registry plus a bounded tail of these events.

// Common envelope. `id` is monotonic within a session and is the ORDERING KEY —
// wall-clock `at` collides across the main child and subagent children.
// `agent` is the entire subagent-visibility mechanism: "main" events form the
// tier-1 timeline; agent:"sub_N" events render inside that subagent's card,
// with `parent` naming the tier-1 turn that spawned it.
const base = {
  id: z.number().int(),
  at: z.string(), // ISO-8601, display only
  session: z.string(),
  agent: z.string(), // "main" | subagent id (e.g. "sub_3")
  turn: z.string().optional(), // owning turnId <sessionId>-<n>
  parent: z.string().optional(), // subagent events: the spawning tier-1 turn
};

export const ActivityEvent = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("session"),
    phase: z.enum(["begin", "end"]),
    reason: z.enum(["phrase", "button", "idle", "shutdown"]).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("turn"),
    phase: z.enum(["begin", "end"]),
    // "system" = a jarvisd-minted announcement performance (background reports)
    source: z.enum(["voice", "text", "system"]).optional(),
    status: z.enum(["ok", "interrupted", "error"]).optional(),
  }),
  z.object({ ...base, kind: z.literal("heard"), text: z.string() }),
  z.object({ ...base, kind: z.literal("say"), text: z.string() }),
  // periodic TAIL snapshot of the private workspace (last ~600 chars), matching
  // the debounced thought push — persisting raw deltas would staircase
  z.object({ ...base, kind: z.literal("think"), text: z.string() }),
  z.object({
    ...base,
    kind: z.literal("exhibit"),
    op: z.enum(["show", "update", "dismiss"]),
    exhibitId: z.string(),
    exhibitType: z.string().optional(),
    title: z.string().optional(),
    // record ref, never payload, when a ref exists (privacy blast radius)
    ref: z.string().optional(),
    payload: z.string().optional(),
  }),
  // ONE event per tool call that resolves in place: emitted `running` when the
  // input is complete, re-emitted with output/status/durationMs when the result
  // lands. Consumers upsert by callId.
  z.object({
    ...base,
    kind: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    input: z.string().optional(),
    status: z.enum(["running", "ok", "error"]),
    output: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("subagent"),
    op: z.enum(["start", "instruct", "status", "done", "error", "closed"]),
    subId: z.string(),
    label: z.string().optional(),
    model: z.string().optional(),
    state: z.string().optional(),
    instruction: z.string().optional(),
    summary: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("note"),
    level: z.enum(["info", "warn", "error"]),
    text: z.string(),
  }),
]);
export type ActivityEvent = z.infer<typeof ActivityEvent>;

// What producers hand the store: the store stamps id/at/session.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ActivityDraft = DistributiveOmit<ActivityEvent, "id" | "at" | "session">;

// A currently-live exhibit for the reconnect replay. Carries the ORIGINAL
// turnId — the stage keys exhibits `${turnId}:${id}`, so replay is idempotent
// only if the key survives.
export const LiveExhibit = z.object({
  turnId: z.string(),
  id: z.string(),
  exhibit: Exhibit,
});
export type LiveExhibit = z.infer<typeof LiveExhibit>;

// Bound a captured blob for the durable log: above the cap, record a truncated
// head plus honest bookkeeping instead of the full body (design §II.8).
export function boundText(text: string, cap = 10_000, head = 4_000): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, head)}\n…[truncated: ${text.length} chars total]`;
}
