import Anthropic from "@anthropic-ai/sdk";
import { runTurn } from "./loop.js";
import type { McpManager, McpServerSpec } from "../mcp/manager.js";
import { McpManager as Manager } from "../mcp/manager.js";

// Tier-2: detached runs of the same loop on the slower/stronger model.
// Own MCP connections (no client sharing with tier-1) and a reduced toolset:
// informational + wiki PROPOSALS only — never wiki_commit, never browser
// performative tools. An injected instruction that survives into a background
// task finds no actuator and no unreviewed write path (design §Security).
const TIER2_ALLOWED = /^(wiki_(search|read|propose_edit)|browser_read|facts_)/;

const TIER2_SYSTEM = `You are Jarvis's background worker. Complete the task using your tools, \
then reply with a concise plain-text report of what you did and found. You may stage wiki \
edits with wiki_propose_edit — Rafe will review the diffs as a batch; you cannot commit. \
No stage markup; this output is a report, not a performance.`;

export interface BackgroundReport {
  taskId: string;
  task: string;
  report: string;
  proposals: string[]; // proposal ids staged for batch confirmation
}

export class BackgroundRunner {
  private counter = 0;

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly serverSpecs: McpServerSpec[],
    private readonly onDone: (report: BackgroundReport) => void,
  ) {}

  dispatch(task: string): string {
    const taskId = `bg${++this.counter}`;
    void this.run(taskId, task);
    return taskId;
  }

  private async run(taskId: string, task: string): Promise<void> {
    const mcp: McpManager = new Manager();
    const proposals: string[] = [];
    try {
      await mcp.connectAll(this.serverSpecs);
      const tools = mcp.tools().filter((t) => TIER2_ALLOWED.test(t.name));
      const result = await runTurn({
        client: this.client,
        model: this.model,
        history: [{ role: "user", content: task }],
        tools,
        execute: async (name, input) => {
          const out = await mcp.execute(name, input);
          const m = out.match(/proposal (\w+)/);
          if (name === "wiki_propose_edit" && m) proposals.push(m[1]!);
          return out;
        },
        callbacks: { onTextDelta: () => {} },
        signal: new AbortController().signal,
        maxTokens: 8192,
        systemOverride: TIER2_SYSTEM,
      });
      this.onDone({ taskId, task, report: result.fullText.trim(), proposals });
    } catch (err) {
      this.onDone({ taskId, task, report: `background task failed: ${String(err)}`, proposals });
    }
  }
}
