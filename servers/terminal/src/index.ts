// jarvis terminal eyes — read-only scrollback of the active terminal session,
// so "why is this failing?" resolves at a shell. Strategy order: tmux active
// pane → iTerm2 AppleScript → Terminal.app AppleScript. Read-only by design.

import { execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const TAIL_LINES = 80;

function tryTmux(): string | null {
  try {
    const out = execFileSync(
      "tmux",
      ["capture-pane", "-p", "-S", `-${TAIL_LINES}`],
      { encoding: "utf8", timeout: 1500 },
    );
    return out.trimEnd() || null;
  } catch {
    return null;
  }
}

function osascript(script: string): string | null {
  try {
    return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 2000 }).trimEnd();
  } catch {
    return null;
  }
}

function tryIterm(): string | null {
  const out = osascript(
    'tell application "iTerm2" to if it is running then tell current session of current window to get contents',
  );
  return out || null;
}

function tryTerminalApp(): string | null {
  const out = osascript(
    'tell application "Terminal" to if it is running then get contents of selected tab of front window',
  );
  return out || null;
}

const server = new McpServer({ name: "jarvis-terminal", version: "0.1.0" });

server.tool(
  "terminal_context",
  "Recent scrollback of Rafe's active terminal session (read-only).",
  {},
  async () => {
    const sources: Array<[string, () => string | null]> = [
      ["tmux", tryTmux],
      ["iterm2", tryIterm],
      ["terminal.app", tryTerminalApp],
    ];
    for (const [name, fn] of sources) {
      const content = fn();
      if (content) {
        const tail = content.split("\n").slice(-TAIL_LINES).join("\n");
        return { content: [{ type: "text", text: `[${name}] last ${TAIL_LINES} lines:\n${tail}` }] };
      }
    }
    return { content: [{ type: "text", text: "no readable terminal session found" }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
