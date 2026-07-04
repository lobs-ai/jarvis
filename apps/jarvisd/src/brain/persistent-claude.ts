import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ThinkingLevel } from "@jarvis/protocol";

// The shared persistent-`claude` primitive (design §II.5 "refactor, don't
// fork"): one warm child in stream-json in/out mode, user messages written to
// stdin, the full event stream parsed into typed callbacks. Tier-1 (CliBrain)
// is one instance with the say tool and voice wiring on top; each tier-2
// subagent is one instance with a reduced toolset. Both get full-fidelity tool
// input/output capture from the same parse — that is what feeds Activity.

// Env vars that would steer the Claude CLI to an API key / Bedrock / Vertex
// instead of Rafe's Claude Code OAuth subscription. Cleared from the child.
export const CLEAR_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_API_TOKEN", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
];

export const MODEL_ALIAS: Record<string, string> = {
  "claude-sonnet-5": "sonnet",
  "claude-fable-5": "opus", // fable rides the Opus-tier subscription entitlement
  "claude-opus-4-8": "opus",
  "claude-haiku-4-5": "haiku",
};

export interface CliServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PersistentClaudeOptions {
  binary?: string;
  label: string; // log prefix: "cli-brain", "sub_3", …
  model: string; // raw model name; alias-mapped at spawn
  thinking: ThinkingLevel;
  appendSystemPrompt: string;
  servers: CliServerSpec[];
  allowedTools: string[];
  disallowedTools: string[];
}

export interface PersistentClaudeEvents {
  onReady?: (model: string) => void;
  // content_block_start of a tool_use block — the input is NOT known yet
  // (verified: inputs arrive only as input_json_delta, complete at block stop)
  onToolStart?: (callId: string, name: string, index: number) => void;
  // raw input_json_delta fragment (CliBrain streams the say tool's text off this)
  onToolInputDelta?: (index: number, callId: string, name: string, partial: string) => void;
  // block stop: accumulated input parsed — this is where a `running` tool
  // activity event is born
  onToolInput?: (callId: string, name: string, input: unknown) => void;
  // matching tool_result arrived (rides user-role messages)
  onToolResult?: (callId: string, name: string, output: string, isError: boolean, durationMs: number) => void;
  onText?: (delta: string) => void; // plain text — the model's private workspace
  onThinking?: (delta: string) => void; // extended thinking deltas
  onResult?: (text: string, subtype: string) => void; // turn/instruction complete
  onExit?: (code: number | null) => void;
}

interface OpenTool {
  name: string;
  inputBuf: string;
  startedAt: number;
}

export class PersistentClaude {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private readyLogged = false;
  // tool_use id → open-call bookkeeping; survives across the turn so results
  // that land later (Bash, web) still correlate and carry a real duration.
  private open = new Map<string, OpenTool>();
  private indexToCall = new Map<number, string>();

  constructor(
    private readonly opts: PersistentClaudeOptions,
    private readonly ev: PersistentClaudeEvents,
  ) {}

  get alive(): boolean {
    return this.child !== null && !this.child.killed;
  }

  ensure(): void {
    if (this.alive) return;

    // MCP servers need PATH/HOME (tsx resolves `node` via PATH); merge them in.
    const baseEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };
    const mcpConfig = {
      mcpServers: Object.fromEntries(
        this.opts.servers.map((s) => [
          s.name,
          { type: "stdio", command: s.command, args: s.args, env: { ...baseEnv, ...(s.env ?? {}) } },
        ]),
      ),
    };
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources", "user",
      "--permission-mode", "bypassPermissions",
      "--model", MODEL_ALIAS[this.opts.model] ?? this.opts.model,
      "--append-system-prompt", this.opts.appendSystemPrompt,
      "--mcp-config", JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      "--allowedTools", this.opts.allowedTools.join(","),
      "--disallowedTools", this.opts.disallowedTools.join(","),
    ];
    if (this.opts.thinking !== "off") args.push("--effort", this.opts.thinking);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string" && !CLEAR_ENV.includes(k)) env[k] = v;
    }
    // "off" is ours — MAX_THINKING_TOKENS=0 disables extended thinking entirely
    // (opus defaults it ON — measured ~9s of dead air on the voice path).
    if (this.opts.thinking === "off") env.MAX_THINKING_TOKENS = "0";
    // Claude Code 2.1.x defers ALL MCP tools behind ToolSearch by default —
    // including say, so the model had to search for its own voice. Our surfaces
    // are ~10 tools; pin them all.
    env.ENABLE_TOOL_SEARCH = "false";

    const child = spawn(this.opts.binary ?? "claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.readyLogged = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    let stderrTail = "";
    child.stderr.on("data", (d: string) => {
      stderrTail = (stderrTail + d).slice(-500);
      const line = d.trim();
      if (line) console.error(`[${this.opts.label} stderr] ${line.slice(0, 300)}`);
    });
    child.on("error", (err) => {
      console.error(`[${this.opts.label}] spawn error: ${err.message}`);
      this.child = null;
      this.ev.onExit?.(-1);
    });
    child.on("exit", (code) => {
      if (code && code !== 0) {
        console.error(`[${this.opts.label}] claude exited ${code}: ${stderrTail.trim().slice(-300)}`);
      }
      this.child = null;
      this.ev.onExit?.(code);
    });
    this.child = child;
  }

  // Write one user turn/instruction to the warm child. Returns false if the
  // child is gone and could not accept it.
  sendUser(content: string): boolean {
    this.ensure();
    if (!this.child) return false;
    try {
      this.child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      );
      return true;
    } catch {
      return false;
    }
  }

  private interruptSeq = 0;
  // stream-json control protocol: cancels the in-flight generation mid-agentic-
  // loop; the child answers with a result event for the cancelled turn promptly.
  interrupt(): void {
    if (!this.alive) return;
    try {
      this.child!.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: `jarvis_int_${++this.interruptSeq}`,
          request: { subtype: "interrupt" },
        }) + "\n",
      );
    } catch {
      /* best-effort — worst case the caller discards until the natural result */
    }
  }

  kill(): void {
    const child = this.child;
    this.child = null; // detach first so the exit handler sees a deliberate kill
    if (child && !child.killed) {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      child.kill();
    }
    this.stdoutBuf = "";
    this.open.clear();
    this.indexToCall.clear();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.onEvent(line);
    }
  }

  private onEvent(line: string): void {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const type = e.type as string;

    if (process.env.JARVIS_BRAIN_DEBUG) {
      const se = (e.event ?? {}) as Record<string, unknown>;
      const detail = type === "stream_event" ? `/${se.type}` : "";
      console.log(`[${this.opts.label} dbg] ${type}${detail} ${line.slice(0, 140)}`);
    }

    // Claude Code emits system/init once per QUERY, not per process — announce
    // only the first, or the log reads like a per-turn respawn (it isn't).
    if (type === "system" && e.subtype === "init") {
      if (!this.readyLogged) {
        this.readyLogged = true;
        const model = (e as { model?: string }).model ?? "?";
        console.log(`[${this.opts.label}] child ready (model ${model})`);
        this.ev.onReady?.(model);
      }
      return;
    }

    if (type === "stream_event") {
      const se = (e.event ?? {}) as Record<string, unknown>;
      const index = typeof se.index === "number" ? se.index : -1;

      if (se.type === "content_block_start") {
        const block = (se.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string") {
          this.open.set(block.id, { name: block.name, inputBuf: "", startedAt: Date.now() });
          this.indexToCall.set(index, block.id);
          this.ev.onToolStart?.(block.id, block.name, index);
        }
        return;
      }

      if (se.type === "content_block_delta") {
        const delta = (se.delta ?? {}) as Record<string, unknown>;
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const callId = this.indexToCall.get(index);
          const open = callId ? this.open.get(callId) : undefined;
          if (callId && open) {
            open.inputBuf += delta.partial_json;
            this.ev.onToolInputDelta?.(index, callId, open.name, delta.partial_json);
          }
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          this.ev.onText?.(delta.text);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          this.ev.onThinking?.(delta.thinking);
        }
        return;
      }

      if (se.type === "content_block_stop") {
        const callId = this.indexToCall.get(index);
        if (callId) {
          this.indexToCall.delete(index);
          const open = this.open.get(callId);
          if (open) {
            // input complete: parse and surface. startedAt resets here so the
            // reported duration measures tool EXECUTION, not input generation.
            open.startedAt = Date.now();
            let input: unknown;
            try {
              input = open.inputBuf ? JSON.parse(open.inputBuf) : {};
            } catch {
              input = open.inputBuf;
            }
            open.inputBuf = ""; // don't hold big payloads twice
            this.ev.onToolInput?.(callId, open.name, input);
          }
        }
        return;
      }
      return;
    }

    // tool results arrive as user-role messages injected by Claude Code
    if (type === "user") {
      const msg = (e.message ?? {}) as { content?: unknown };
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const raw of blocks) {
        const b = raw as Record<string, unknown>;
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const open = this.open.get(b.tool_use_id);
        if (!open) continue;
        this.open.delete(b.tool_use_id);
        this.ev.onToolResult?.(
          b.tool_use_id,
          open.name,
          extractText(b.content),
          b.is_error === true,
          Date.now() - open.startedAt,
        );
      }
      return;
    }

    if (type === "result") {
      if (typeof e.subtype === "string" && e.subtype !== "success") {
        console.error(`[${this.opts.label}] result ${e.subtype}: ${String(e.result ?? "").slice(0, 200)}`);
      }
      // a result closes the turn — any tools still open died with it
      this.open.clear();
      this.indexToCall.clear();
      this.ev.onResult?.(
        typeof e.result === "string" ? e.result : "",
        typeof e.subtype === "string" ? e.subtype : "success",
      );
    }
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const x = b as Record<string, unknown>;
        return x.type === "text" && typeof x.text === "string" ? x.text : "";
      })
      .join("\n");
  }
  return "";
}
