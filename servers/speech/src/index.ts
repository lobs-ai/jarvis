// jarvis speech — the say tool, served to the CLI brain only.
//
// This server is deliberately a stub. jarvisd watches the Claude Code event
// stream and performs say's input text (TTS + captions + stage tags) from the
// input_json_delta events AS THE MODEL GENERATES IT — speech is already playing
// by the time this handler runs. All it does is ack fast so the agent's loop
// continues while the audio plays; the agent talks and works concurrently.
//
// The tool must still exist as a real MCP tool: it is what makes "speaking" an
// action the model chooses, instead of jarvisd surfacing every streamed token.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "jarvis-speech", version: "0.1.0" });

server.tool(
  "say",
  "Speak to Rafe. The text is read aloud by TTS and captioned on the stage as you write it; " +
    "stage tags (<show>/<update>/<dismiss>) may be embedded. Returns immediately — speech " +
    "plays while you keep working. This is the ONLY way Rafe hears you.",
  { text: z.string().describe("what to speak, with optional inline stage tags") },
  async () => ({ content: [{ type: "text", text: "spoken" }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
