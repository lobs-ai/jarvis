import type { ToolDef, ToolExecutor } from "./loop.js";

export interface BrainCallbacks {
  onTextDelta: (delta: string) => void;
  onToolCall?: (name: string) => void;
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
  dispose?(): void;
}
