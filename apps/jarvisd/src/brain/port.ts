import type { ToolDef, ToolExecutor } from "./loop.js";

export interface BrainCallbacks {
  onTextDelta: (delta: string) => void; // SPOKEN text (say-tool input, or all text on the stream path)
  onToolCall?: (name: string) => void;
  // private-workspace text (never spoken) — surfaced as the stage's dim
  // inner-monologue line so silent work is visibly alive
  onThought?: (delta: string) => void;
}

// The brain is swappable (design §Brain wiring): CliBrain rides Rafe's Claude
// Code subscription; ApiBrain uses the Anthropic SDK with an API key. Each owns
// its own conversation state — Session drives turns and the performance layer,
// not history.
export interface BrainPort {
  readonly kind: "cli" | "api";
  // Deliver one user turn; stream assistant text via callbacks; resolve when
  // the turn ends (or is aborted via signal).
  turn(userText: string, cb: BrainCallbacks, signal: AbortSignal): Promise<{
    fullText: string;
    aborted: boolean;
  }>;
  // Barge-in: record that the just-aborted turn only performed `performedText`,
  // so the model's memory matches what Rafe actually heard.
  recordInterrupted(performedText: string): void;
  // Tool wiring. ApiBrain calls the executor itself; CliBrain lets Claude Code
  // call MCP servers directly and ignores the executor (it still uses the defs
  // to know which tools exist).
  setTools?(tools: ToolDef[], executor: ToolExecutor): void;
  // Settings: adopt a new model/thinking budget. Takes effect on the next
  // reset() (CliBrain bakes both into the child's spawn args/env).
  configure?(patch: { model?: string; thinking?: "off" | "low" | "medium" | "high" }): void;
  // Drop conversation history and start fresh on the next turn.
  reset?(): void;
  dispose?(): void;
}
