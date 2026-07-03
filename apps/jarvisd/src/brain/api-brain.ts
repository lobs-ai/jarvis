import Anthropic from "@anthropic-ai/sdk";
import { runTurn, type ToolDef, type ToolExecutor } from "./loop.js";
import type { BrainPort, BrainCallbacks } from "./port.js";

// Anthropic SDK brain: jarvisd owns history + tool execution. Needs an API key.
// Kept as the fallback when the Claude Code CLI isn't available.
export class ApiBrain implements BrainPort {
  readonly kind = "api" as const;
  private history: Anthropic.MessageParam[] = [];
  private tools: ToolDef[] = [];
  private executor: ToolExecutor = async (n) => `no such tool: ${n}`;

  constructor(
    private readonly client: Anthropic,
    private model: string,
    private readonly facts: () => string | null,
  ) {}

  configure(patch: { model?: string }): void {
    if (patch.model) this.model = patch.model;
  }

  reset(): void {
    this.history = [];
  }

  setTools(tools: ToolDef[], executor: ToolExecutor): void {
    this.tools = tools;
    this.executor = executor;
  }

  async turn(userText: string, cb: BrainCallbacks, signal: AbortSignal) {
    this.history.push({ role: "user", content: userText });
    const result = await runTurn({
      client: this.client,
      model: this.model,
      history: this.history,
      tools: this.tools,
      execute: this.executor,
      callbacks: cb,
      signal,
      facts: this.facts(),
    });
    if (!result.aborted) this.history.push({ role: "assistant", content: result.fullText });
    return result;
  }

  recordInterrupted(performedText: string): void {
    if (performedText) this.history.push({ role: "assistant", content: performedText });
  }
}
