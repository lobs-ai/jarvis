import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.js";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolExecutor {
  (name: string, input: Record<string, unknown>): Promise<string>;
}

export interface TurnCallbacks {
  onTextDelta: (delta: string) => void;
  onToolCall?: (name: string) => void;
}

export interface TurnResult {
  // the model's full raw output (incl. markup tags) across all sub-generations,
  // used as the assistant history entry on clean completion
  fullText: string;
  aborted: boolean;
}

// Tier-1 conversational loop: one logical turn may span several generations when
// the model calls real tools (a tool_use block ends a generation — this is the
// Messages-API constraint that pushed stage directives into text markup).
export async function runTurn(opts: {
  client: Anthropic;
  model: string;
  history: Anthropic.MessageParam[]; // NOT mutated; caller owns history
  tools: ToolDef[];
  execute: ToolExecutor;
  callbacks: TurnCallbacks;
  signal: AbortSignal;
  maxTokens?: number;
}): Promise<TurnResult> {
  const { client, model, tools, execute, callbacks, signal } = opts;
  const messages: Anthropic.MessageParam[] = [...opts.history];
  let fullText = "";

  for (let hop = 0; hop < 8; hop++) {
    if (signal.aborted) return { fullText, aborted: true };

    const stream = client.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? 4096,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
        ...(tools.length > 0 ? { tools: tools as Anthropic.Tool[] } : {}),
      },
      { signal },
    );

    stream.on("text", (delta) => {
      fullText += delta;
      callbacks.onTextDelta(delta);
    });

    let finalMessage: Anthropic.Message;
    try {
      finalMessage = await stream.finalMessage();
    } catch (err) {
      if (signal.aborted) return { fullText, aborted: true };
      throw err;
    }

    if (finalMessage.stop_reason !== "tool_use") {
      return { fullText, aborted: false };
    }

    // Execute every tool_use block, then continue the turn.
    messages.push({ role: "assistant", content: finalMessage.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of finalMessage.content) {
      if (block.type !== "tool_use") continue;
      callbacks.onToolCall?.(block.name);
      let output: string;
      try {
        output = await execute(block.name, block.input as Record<string, unknown>);
      } catch (err) {
        output = `tool error: ${String(err)}`;
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
    fullText += "\n";
  }

  return { fullText, aborted: false };
}
