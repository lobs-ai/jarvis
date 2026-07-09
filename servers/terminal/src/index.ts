// jarvis terminal — eyes AND hands at the shell.
//   terminal_context: read-only awareness of Rafe's tmux. Two tiers:
//     ROSTER — every pane across every session (id, dir, running command,
//       which is active) so Jarvis knows the whole workspace at a glance.
//     DEEP   — full scrollback of the active pane (the one Rafe is looking at).
//     Drill-down into any *other* pane needs no tool here: the brain has a
//     shell and runs `tmux capture-pane -t <pane> -p -S -80` itself.
//     Fallback when tmux is absent: iTerm2 / Terminal.app active session.
//   terminal_run: run a command (zsh) in a fresh subshell — the API-path
//     equivalent of the CLI brain's built-in Bash tool. It does NOT type into
//     Rafe's visible terminal; his sessions stay his.

import { execFile, execFileSync } from "node:child_process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const TAIL_LINES = 80;
const ROSTER_CAP = 40; // panes listed before we summarize the rest

// ROSTER: one line per pane across all sessions/windows. Cheap — a single
// tmux call, no per-pane scrollback — so it fits the bundle budget easily.
function tmuxRoster(): string | null {
  try {
    const out = execFileSync(
      "tmux",
      [
        "list-panes",
        "-a",
        "-F",
        "#{session_name}:#{window_index}.#{pane_index}  #{pane_current_path}  [#{pane_current_command}]#{?pane_active,  *ACTIVE,}",
      ],
      { encoding: "utf8", timeout: 1500 },
    );
    const lines = out.trimEnd().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const shown = lines.slice(0, ROSTER_CAP).join("\n");
    const extra = lines.length > ROSTER_CAP ? `\n… +${lines.length - ROSTER_CAP} more panes` : "";
    return `tmux panes (${lines.length}):\n${shown}${extra}`;
  } catch {
    return null;
  }
}

// DEEP: scrollback of the active pane (default target when -t is omitted).
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
  "Rafe's terminal, read-only: a roster of every tmux pane (all sessions) plus the active pane's recent scrollback.",
  {},
  async () => {
    const roster = tmuxRoster();
    const sources: Array<[string, () => string | null]> = [
      ["tmux", tryTmux],
      ["iterm2", tryIterm],
      ["terminal.app", tryTerminalApp],
    ];
    for (const [name, fn] of sources) {
      const content = fn();
      if (content) {
        const tail = content.split("\n").slice(-TAIL_LINES).join("\n");
        const head = roster ? `${roster}\n\n` : "";
        return {
          content: [
            { type: "text", text: `${head}[${name}] active pane, last ${TAIL_LINES} lines:\n${tail}` },
          ],
        };
      }
    }
    // No readable active surface, but the roster alone is still useful.
    if (roster) return { content: [{ type: "text", text: roster }] };
    return { content: [{ type: "text", text: "no readable terminal session found" }] };
  },
);

const RUN_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 8_000; // chars — long output belongs on the stage, summarized

server.tool(
  "terminal_run",
  "Run a shell command on Rafe's Mac (zsh, fresh subshell, 30s timeout). Returns exit code " +
    "plus combined stdout/stderr, capped. Use freely for readable/reversible work; ask Rafe " +
    "aloud before anything destructive or hard to reverse.",
  {
    command: z.string().describe("the command line to run"),
    cwd: z.string().optional().describe("working directory (default: Rafe's home)"),
  },
  async ({ command, cwd }) =>
    new Promise((resolve) => {
      execFile(
        "/bin/zsh",
        ["-lc", command],
        {
          cwd: cwd || process.env.HOME,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          const killed = err && "killed" in err && (err as { killed?: boolean }).killed;
          const code = err ? ((err as { code?: number | string }).code ?? 1) : 0;
          let out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n").trimEnd();
          if (out.length > OUTPUT_CAP) out = out.slice(0, OUTPUT_CAP) + "\n[output truncated]";
          // A failing command is data, not a tool error — the model reads the
          // exit header and diagnoses; isError would mask output as "tool error".
          const head = killed
            ? `[timed out after ${RUN_TIMEOUT_MS / 1000}s]`
            : `[exit ${typeof code === "number" ? code : `signal ${code}`}]`;
          resolve({ content: [{ type: "text", text: `${head}\n${out || "(no output)"}` }] });
        },
      );
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
