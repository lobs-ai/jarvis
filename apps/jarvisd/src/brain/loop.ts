import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./prompt.js";

// The SDK path keeps the legacy speech contract: all streamed text IS speech.
const STREAM_PROMPT = buildSystemPrompt("stream");

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
  onToolStart?: (callId: string, name: string) => void;
  onToolCall?: (callId: string, name: string, input: unknown) => void;
  onToolResult?: (
    callId: string,
    name: string,
    output: string,
    isError: boolean,
    durationMs: number,
  ) => void;
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
  facts?: string | null;
  systemOverride?: string;
}): Promise<TurnResult> {
  const { client, model, tools, execute, callbacks, signal } = opts;
  const messages: Anthropic.MessageParam[] = [...opts.history];
  let fullText = "";

  // Debug harness (design: text is the debug path forever): JARVIS_MOCK_BRAIN
  // replays a canned performance token-by-token, so the whole pipeline is
  // provable with no API key. Never engaged when a real key is present in prod.
  if (process.env.JARVIS_MOCK_BRAIN) {
    const canned = mockPerformance(lastUserText(messages));
    for (const ch of canned) {
      if (signal.aborted) return { fullText, aborted: true };
      fullText += ch;
      callbacks.onTextDelta(ch);
      await new Promise((r) => setTimeout(r, 4));
    }
    return { fullText, aborted: false };
  }

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: opts.systemOverride ?? STREAM_PROMPT, cache_control: { type: "ephemeral" } },
  ];
  // facts change rarely; a separate uncached block preserves the prompt cache
  if (opts.facts) {
    system.push({ type: "text", text: `## What you know about working with Rafe\n\n${opts.facts}` });
  }

  for (let hop = 0; hop < 8; hop++) {
    if (signal.aborted) return { fullText, aborted: true };

    const stream = client.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? 4096,
        system,
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
      callbacks.onToolStart?.(block.id, block.name);
      callbacks.onToolCall?.(block.id, block.name, block.input);
      const t0 = Date.now();
      let output: string;
      let isError = false;
      try {
        output = await execute(block.name, block.input as Record<string, unknown>);
      } catch (err) {
        output = `tool error: ${String(err)}`;
        isError = true;
      }
      callbacks.onToolResult?.(block.id, block.name, output, isError, Date.now() - t0);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
    fullText += "\n";
  }

  return { fullText, aborted: false };
}

function lastUserText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function mockPerformance(userText: string): string {
  return (
    `You asked about "${userText.slice(0, 40)}". Here's the shape of it. ` +
    `<show id="e1" type="markdown" title="mock exhibit">## It works\n\n` +
    `This exhibit was **conjured mid-sentence** by the mock brain — proving the ` +
    `compiler, queue, and stage render in sync without any API key.\n\n` +
    `- say items stream as captions\n- show items materialize in stream order</show> ` +
    `The card appeared right as I mentioned it, then I keep talking afterward. ` +
    `<dismiss ref="e1"/> And now it's swept away. That's the performance engine end to end.`
  );
}
