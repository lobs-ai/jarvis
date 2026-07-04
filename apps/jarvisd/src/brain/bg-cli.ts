import { spawn } from "node:child_process";
import type { ThinkingLevel } from "@jarvis/protocol";
import type { BackgroundReport } from "./tasks.js";
import { TIER2_SYSTEM } from "./tasks.js";
import type { CliServerSpec } from "./cli-brain.js";

// Tier-2 on the subscription path: each background task is one detached
// one-shot `claude -p` run — no warm child, because nobody is waiting on its
// first token. Deliberation is free here (Rafe's call: opus + xhigh), and the
// toolset is the same reduced set as the API-path runner: informational +
// wiki PROPOSALS only, so a runaway task finds no actuator and no unreviewed
// write path (design §Security). Settings apply live: model/effort are read
// at dispatch.

const MODEL_ALIAS: Record<string, string> = {
  "claude-sonnet-5": "sonnet",
  "claude-fable-5": "opus", // fable rides the Opus-tier subscription entitlement
  "claude-opus-4-8": "opus",
  "claude-haiku-4-5": "haiku",
};

const TIER2_ALLOWED = [
  "mcp__wiki__wiki_search",
  "mcp__wiki__wiki_read",
  "mcp__wiki__wiki_list",
  "mcp__wiki__wiki_propose_edit",
  "WebSearch",
  "WebFetch",
];
const TIER2_DISALLOWED = [
  "Bash", "Edit", "Write", "NotebookEdit", "TodoWrite",
  "mcp__wiki__wiki_commit", "mcp__wiki__wiki_context",
];

const CLEAR_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_API_TOKEN", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
];

const TASK_TIMEOUT_MS = 15 * 60_000; // a background task, not a background lifestyle

export interface CliBackgroundOptions {
  binary?: string;
  model: () => string;
  thinking: () => ThinkingLevel;
  servers: CliServerSpec[]; // wiki only — see TIER2_ALLOWED
  onDone: (report: BackgroundReport) => void;
}

export class CliBackground {
  private counter = 0;

  constructor(private readonly opts: CliBackgroundOptions) {}

  dispatch(task: string): string {
    const taskId = `bg${++this.counter}`;
    void this.run(taskId, task);
    return taskId;
  }

  private async run(taskId: string, task: string): Promise<void> {
    const proposals: string[] = [];
    try {
      const report = await this.spawnTask(task, proposals);
      this.opts.onDone({ taskId, task, report: report.trim(), proposals });
    } catch (err) {
      this.opts.onDone({ taskId, task, report: `background task failed: ${String(err)}`, proposals });
    }
  }

  private spawnTask(task: string, proposals: string[]): Promise<string> {
    const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const mcpConfig = {
      mcpServers: Object.fromEntries(
        this.opts.servers.map((s) => [
          s.name,
          { type: "stdio", command: s.command, args: s.args, env: { ...baseEnv, ...(s.env ?? {}) } },
        ]),
      ),
    };
    const model = this.opts.model();
    const thinking = this.opts.thinking();
    const args = [
      "-p", task,
      // stream-json (not plain json) so wiki_propose_edit results are visible
      // as they land — that's where the proposal ids for batch review come from
      "--output-format", "stream-json",
      "--verbose",
      "--setting-sources", "user",
      "--permission-mode", "bypassPermissions",
      "--model", MODEL_ALIAS[model] ?? model,
      "--append-system-prompt", TIER2_SYSTEM,
      "--mcp-config", JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      "--allowedTools", TIER2_ALLOWED.join(","),
      "--disallowedTools", TIER2_DISALLOWED.join(","),
    ];
    if (thinking !== "off") args.push("--effort", thinking);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string" && !CLEAR_ENV.includes(k)) env[k] = v;
    }
    env.ENABLE_TOOL_SEARCH = "false"; // small toolset — pin it, same as tier-1
    if (thinking === "off") env.MAX_THINKING_TOKENS = "0";

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.opts.binary ?? "claude", args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const killer = setTimeout(() => {
        child.kill();
        reject(new Error(`timed out after ${TASK_TIMEOUT_MS / 60_000} minutes`));
      }, TASK_TIMEOUT_MS);

      let buf = "";
      let result: string | null = null;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const e = JSON.parse(line) as Record<string, unknown>;
            if (e.type === "user") {
              // tool results ride user-role messages; harvest staged proposals
              const msg = (e.message ?? {}) as { content?: unknown };
              const blocks = Array.isArray(msg.content) ? msg.content : [];
              for (const raw of blocks) {
                const b = raw as Record<string, unknown>;
                if (b.type !== "tool_result") continue;
                const m = JSON.stringify(b.content ?? "").match(/proposal (\w+)/);
                if (m) proposals.push(m[1]!);
              }
            } else if (e.type === "result") {
              result = typeof e.result === "string" ? e.result : "";
            }
          } catch {
            /* non-JSON line — ignore */
          }
        }
      });
      let stderrTail = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => (stderrTail = (stderrTail + d).slice(-400)));
      child.on("error", (err) => {
        clearTimeout(killer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(killer);
        if (result !== null) resolve(result);
        else reject(new Error(`claude exited ${code ?? "?"}: ${stderrTail.trim().slice(-200)}`));
      });
    });
  }
}
