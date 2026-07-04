// jarvis tasks — lets the tier-1 voice hand long work to the background worker.
//
// Thin by design, like the settings server: dispatch_background POSTs to
// jarvisd's HTTP control endpoint (127.0.0.1:$JARVIS_PORT/tasks), and jarvisd
// owns the actual worker (a detached one-shot claude run on the tier-2
// model/effort). The tool returns immediately with a task id; the report is
// announced into the conversation when the channel goes idle.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const PORT = process.env.JARVIS_PORT ?? "7430";
const TASKS_URL = `http://127.0.0.1:${PORT}/tasks`;

const server = new McpServer({ name: "jarvis-tasks", version: "0.1.0" });

server.tool(
  "dispatch_background",
  "Hand a long-running task to your background worker — a stronger, slower you with " +
    "deliberation maxed. Returns immediately with a task id; the report arrives in the " +
    "conversation when it finishes. Use for multi-step research or wiki-wide work, NOT " +
    "for quick answers. The worker can read the wiki/web and STAGE wiki edits (Rafe " +
    "reviews them); it cannot commit, touch the shell, or drive the browser.",
  {
    task: z
      .string()
      .min(1)
      .describe("self-contained task description — the worker sees nothing else of this conversation"),
  },
  async ({ task }) => {
    try {
      const res = await fetch(TASKS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const text = await res.text();
      if (!res.ok) return { content: [{ type: "text", text: `rejected: ${text}` }], isError: true };
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `jarvisd unreachable: ${String(err)}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
