// jarvis settings — lets Jarvis read and change its own configuration.
//
// Deliberately thin: both tools call jarvisd's HTTP control endpoint
// (127.0.0.1:$JARVIS_PORT/settings), which is the SINGLE writer for
// ~/.jarvis/config.toml. That keeps every change — from the stage panel, from
// curl, or from Jarvis itself — flowing through one applySettings, so the
// stage UI reflects it immediately and brain restarts are sequenced safely
// (a model/thinking change applies when the current turn ends).

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const PORT = process.env.JARVIS_PORT ?? "7430";
const SETTINGS_URL = `http://127.0.0.1:${PORT}/settings`;

const server = new McpServer({ name: "jarvis-settings", version: "0.1.0" });

server.tool(
  "settings_get",
  "Read Jarvis's current settings: wiki_dir, model_tier1, model_tier2, thinking, " +
    "thinking_tier2, wake_word, wake_enabled.",
  {},
  async () => {
    try {
      const res = await fetch(SETTINGS_URL);
      return { content: [{ type: "text", text: await res.text() }] };
    } catch (err) {
      return { content: [{ type: "text", text: `jarvisd unreachable: ${String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "settings_set",
  "Change Jarvis's own settings. wiki_dir applies immediately; model_tier1 or thinking " +
    "restarts the conversation when the current turn ends (say so aloud first). Only " +
    "change settings when Rafe asks.",
  {
    wiki_dir: z.string().optional().describe("absolute path to the wiki's markdown root"),
    model_tier1: z.string().optional().describe("conversation model, e.g. claude-opus-4-8, claude-sonnet-5"),
    model_tier2: z.string().optional().describe("background-worker model (applies live; each task is a fresh run)"),
    thinking: z
      .enum(["off", "low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("thinking effort (off disables extended thinking; the rest are CLI --effort levels)"),
    thinking_tier2: z
      .enum(["off", "low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("background-worker thinking effort (applies live)"),
    wake_word: z.string().optional().describe("the wake word itself (applies live)"),
    wake_enabled: z
      .boolean()
      .optional()
      .describe(
        "wake-word gate on/off (applies live). On: idle speech needs the wake word. " +
          "Off: Jarvis listens to everything. Rafe toggles this by voice — do it when asked.",
      ),
  },
  async (patch) => {
    try {
      const res = await fetch(SETTINGS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
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
