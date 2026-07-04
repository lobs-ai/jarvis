// jarvis tasks — the tier-1 voice's handle on its interactive tier-2 subagents.
//
// Thin by design, like the settings server: every tool is a proxy to jarvisd's
// /subagents HTTP control endpoint (127.0.0.1:$JARVIS_PORT), and jarvisd owns
// the pool — persistent stream-json claude children you can start, message,
// poll, read, and stop (design §II.5). Their step-by-step work is visible in
// the stage's activity panel. dispatch_background is kept as an alias of
// subagent_start so existing prompt text keeps working.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const PORT = process.env.JARVIS_PORT ?? "7430";
const BASE = `http://127.0.0.1:${PORT}`;

const server = new McpServer({ name: "jarvis-tasks", version: "0.2.0" });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<ToolResult> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    const text = await res.text();
    if (!res.ok) return { content: [{ type: "text", text: `rejected: ${text}` }], isError: true };
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: `jarvisd unreachable: ${String(err)}` }], isError: true };
  }
}

const START_DESCRIPTION =
  "Start a background subagent — a stronger, slower you with deliberation maxed, worth " +
  "minutes not seconds: multi-step research, wiki-wide passes, anything Rafe shouldn't sit " +
  "through. It stays warm after finishing, so you can subagent_send follow-ups. Write the " +
  "task self-contained (it sees nothing of this conversation). It can read files, search, " +
  "run the shell, browse the web, and STAGE wiki edits (Rafe reviews each diff); it cannot " +
  "commit or drive the browser. Returns immediately with an id; the report arrives in the " +
  "conversation when it finishes — tell Rafe it's running and move on.";

const startShape = {
  task: z
    .string()
    .min(1)
    .describe("self-contained task description — the subagent sees nothing else of this conversation"),
  label: z
    .string()
    .optional()
    .describe("short human-readable label for the activity panel, e.g. 'reorganize project pages'"),
};

server.tool("subagent_start", START_DESCRIPTION, startShape, async ({ task, label }) =>
  call("POST", "/subagents", { task, label }),
);

// legacy alias — same effect as subagent_start
server.tool("dispatch_background", START_DESCRIPTION, startShape, async ({ task, label }) =>
  call("POST", "/subagents", { task, label }),
);

server.tool(
  "subagent_send",
  "Send a follow-up instruction or question to a live subagent, with its prior work as " +
    "context. ASYNC: returns immediately; the answer arrives in the conversation when ready " +
    "(never inline). If the subagent is mid-instruction, the message queues.",
  {
    id: z.string().describe("subagent id, e.g. sub_3"),
    message: z.string().min(1).describe("the follow-up instruction or question"),
  },
  async ({ id, message }) => call("POST", `/subagents/${encodeURIComponent(id)}/send`, { message }),
);

server.tool(
  "subagent_status",
  "Status of one subagent (by id) or the whole pool (no id): state (starting/working/idle/" +
    "closed/failed/timed-out), current instruction, elapsed time, tool count, last activity.",
  { id: z.string().optional().describe("subagent id; omit for all") },
  async ({ id }) => call("GET", id ? `/subagents/${encodeURIComponent(id)}` : "/subagents"),
);

server.tool(
  "subagent_result",
  "The latest report/answer text a subagent produced (its reply to the last instruction).",
  { id: z.string().describe("subagent id, e.g. sub_3") },
  async ({ id }) => call("GET", `/subagents/${encodeURIComponent(id)}/result`),
);

server.tool(
  "subagent_stop",
  "Terminate a subagent. Its staged wiki proposals (if any) survive for review.",
  { id: z.string().describe("subagent id, e.g. sub_3") },
  async ({ id }) => call("POST", `/subagents/${encodeURIComponent(id)}/stop`),
);

const transport = new StdioServerTransport();
await server.connect(transport);
