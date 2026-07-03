import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { BrainPort, BrainCallbacks } from "./port.js";

// Env vars that would steer the Claude CLI to an API key / Bedrock / Vertex
// instead of Rafe's Claude Code OAuth subscription. Cleared from the child.
// (Mirrors lobs-core's CLAUDE_CLI_CLEAR_ENV — the whole point is subscription.)
const CLEAR_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_API_TOKEN", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
];

const MODEL_ALIAS: Record<string, string> = {
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

export interface CliBrainOptions {
  binary?: string;
  model: string;
  servers: CliServerSpec[];
  // Tools Claude Code may call directly (reads + proposals). Mutating tools are
  // deliberately excluded — jarvisd gates those (design §Security).
  allowedTools: string[];
  disallowedTools: string[];
  onToolCall?: (name: string) => void;
  onToolResult?: (name: string, text: string) => void;
  facts: () => string | null;
}

interface ActiveTurn {
  cb: BrainCallbacks;
  resolve: (r: { fullText: string; aborted: boolean }) => void;
  fullText: string;
  aborted: boolean;
  discarding: boolean;
}

// One warm `claude` process per session in stream-json in/out mode: MCP servers
// initialize once and stay warm across turns, avoiding the per-invocation
// cold-start tax that makes per-turn `claude -p` spawning fatal for voice.
export class CliBrain implements BrainPort {
  readonly kind = "cli" as const;
  private child: ChildProcessWithoutNullStreams | null = null;
  private active: ActiveTurn | null = null;
  private busy = false;
  private freeWaiters: Array<() => void> = [];
  private stdoutBuf = "";
  private lastToolName = "";

  constructor(private readonly opts: CliBrainOptions) {}

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;

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
    const model = MODEL_ALIAS[this.opts.model] ?? this.opts.model;
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--setting-sources", "user",
      "--permission-mode", "bypassPermissions",
      "--model", model,
      "--append-system-prompt", CLI_PREAMBLE + SYSTEM_PROMPT,
      "--mcp-config", JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      "--allowedTools", this.opts.allowedTools.join(","),
      "--disallowedTools", this.opts.disallowedTools.join(","),
    ];

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string" && !CLEAR_ENV.includes(k)) env[k] = v;
    }

    const child = spawn(this.opts.binary ?? "claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    let stderrTail = "";
    child.stderr.on("data", (d: string) => {
      stderrTail = (stderrTail + d).slice(-500);
    });
    child.on("error", (err) => {
      console.error(`[cli-brain] spawn error: ${err.message}`);
      this.failActive();
    });
    child.on("exit", (code) => {
      if (code && code !== 0) {
        console.error(`[cli-brain] claude exited ${code}: ${stderrTail.trim().slice(-300)}`);
      }
      this.child = null;
      this.failActive();
    });
    this.child = child;
    return child;
  }

  private failActive(): void {
    if (this.active) {
      const a = this.active;
      this.active = null;
      a.resolve({ fullText: a.fullText, aborted: true });
    }
    this.setBusy(false);
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    if (!b) {
      const waiters = this.freeWaiters;
      this.freeWaiters = [];
      for (const w of waiters) w();
    }
  }

  private untilFree(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((r) => this.freeWaiters.push(r));
  }

  async turn(userText: string, cb: BrainCallbacks, signal: AbortSignal) {
    await this.untilFree();
    const child = this.ensureChild();
    this.setBusy(true);

    const facts = this.opts.facts();
    const content = facts ? `<facts>\n${facts}\n</facts>\n\n${userText}` : userText;

    return new Promise<{ fullText: string; aborted: boolean }>((resolve) => {
      // set active BEFORE writing so a fast first delta isn't dropped
      const turn: ActiveTurn = { cb, resolve, fullText: "", aborted: false, discarding: false };
      this.active = turn;
      child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      );
      const onAbort = (): void => {
        // Barge-in: stop forwarding deltas immediately and hand control back.
        // The process keeps generating; we discard until its `result`, then the
        // next turn (which awaits untilFree) may send.
        turn.aborted = true;
        turn.discarding = true;
        signal.removeEventListener("abort", onAbort);
        resolve({ fullText: turn.fullText, aborted: true });
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    });
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
    const turn = this.active;
    const type = e.type as string;

    if (type === "stream_event") {
      const se = (e.event ?? {}) as Record<string, unknown>;
      if (se.type === "content_block_delta") {
        const delta = (se.delta ?? {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (turn && !turn.discarding) {
            turn.fullText += delta.text;
            turn.cb.onTextDelta(delta.text);
          }
        }
      } else if (se.type === "content_block_start") {
        const block = (se.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use" && typeof block.name === "string") {
          this.lastToolName = block.name;
          if (turn && !turn.discarding) turn.cb.onToolCall?.(block.name);
          this.opts.onToolCall?.(block.name);
        }
      }
      return;
    }

    // tool results arrive as user-role messages injected by Claude Code
    if (type === "user") {
      const msg = (e.message ?? {}) as { content?: unknown };
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const raw of blocks) {
        const b = raw as Record<string, unknown>;
        if (b.type === "tool_result") {
          const text = extractText(b.content);
          this.opts.onToolResult?.(this.lastToolName, text);
        }
      }
      return;
    }

    if (type === "result") {
      // turn complete (or the discarded remnant of an interrupted one)
      if (turn && !turn.discarding) {
        turn.resolve({ fullText: turn.fullText, aborted: false });
      }
      this.active = null;
      this.setBusy(false);
    }
  }

  recordInterrupted(): void {
    // Claude Code owns history; the process saw its own partial output. The
    // next turn is prefixed with the interruption note by Session, which is
    // enough for the model to reconcile.
  }

  dispose(): void {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
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

const CLI_PREAMBLE = `IMPORTANT: You are NOT a coding assistant in this session. Ignore any \
default coding-agent framing. You are Jarvis, a spoken assistant. Do not use file, bash, or \
editor tools; use only your provided MCP tools. Everything below defines who you are.\n\n`;
