import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { buildSystemPrompt } from "./prompt.js";
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

// Speech-as-tool (Rafe's redesign): the model is silent by default and speaks
// by calling this tool. jarvisd streams the tool's input text to the compiler
// from input_json_delta events — speech starts before the call even completes,
// and the stub server acks instantly so talking overlaps working.
const SAY_TOOL = "mcp__speech__say";

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
  // Tools Claude Code may call directly (say, shell, reads, wiki proposals).
  // Mutating wiki/browser tools are excluded — jarvisd gates those (design §Security).
  allowedTools: string[];
  disallowedTools: string[];
  onToolCall?: (name: string) => void;
  onToolResult?: (name: string, text: string) => void;
  facts: () => string | null;
}

interface ActiveTurn {
  cb: BrainCallbacks;
  resolve: (r: { fullText: string; aborted: boolean }) => void;
  fullText: string; // what was SPOKEN (say text; or the fallback scratch)
  scratch: string; // plain text the model emitted outside say — private workspace
  saySeen: boolean;
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
  // tool_use id → tool name, so tool_result blocks attribute correctly even
  // when say calls interleave with real work in the same assistant message.
  private toolNames = new Map<string, string>();
  private sayIndex: number | null = null; // content-block index of an in-flight say
  private sayExtractor: SayTextExtractor | null = null;

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
      "--append-system-prompt", CLI_PREAMBLE + buildSystemPrompt("say-tool"),
      "--mcp-config", JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      "--allowedTools", this.opts.allowedTools.join(","),
      "--disallowedTools", this.opts.disallowedTools.join(","),
    ];

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string" && !CLEAR_ENV.includes(k)) env[k] = v;
    }
    // Tier-1 runs thinking OFF (design §Brain): Claude Code defaults opus to
    // extended thinking, which measured ~9s of dead air before the first
    // visible event. JARVIS_THINKING=1 re-enables it (deltas stream into the
    // stage's thought line either way).
    if (!process.env.JARVIS_THINKING) env.MAX_THINKING_TOKENS = "0";

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
      const line = d.trim();
      if (line) console.error(`[cli-brain stderr] ${line.slice(0, 300)}`);
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
    // A turn abandoned while queued (rapid utterances barging into each other)
    // must NOT be sent — the child would grind through a stale agentic loop
    // while fresh turns pile up behind untilFree. That was the "stuck" bug.
    if (signal.aborted) return { fullText: "", aborted: true };
    const child = this.ensureChild();
    this.setBusy(true);

    const facts = this.opts.facts();
    const content = facts ? `<facts>\n${facts}\n</facts>\n\n${userText}` : userText;

    return new Promise<{ fullText: string; aborted: boolean }>((resolve) => {
      // set active BEFORE writing so a fast first delta isn't dropped
      const turn: ActiveTurn = {
        cb, resolve, fullText: "", scratch: "", saySeen: false, aborted: false, discarding: false,
      };
      this.active = turn;
      child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      );
      const onAbort = (): void => {
        // Barge-in: stop forwarding deltas immediately, tell the child to stop
        // generating, and hand control back. Whatever remnant still streams is
        // discarded until its `result`; the interrupt makes that arrive fast
        // instead of after the full agentic loop.
        turn.aborted = true;
        turn.discarding = true;
        this.sendInterrupt();
        signal.removeEventListener("abort", onAbort);
        resolve({ fullText: turn.fullText, aborted: true });
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    });
  }

  private interruptSeq = 0;
  // stream-json control protocol: cancels the in-flight generation; the child
  // answers with a result event for the cancelled turn (freeing `busy`).
  private sendInterrupt(): void {
    if (!this.child || this.child.killed) return;
    try {
      this.child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: `jarvis_int_${++this.interruptSeq}`,
          request: { subtype: "interrupt" },
        }) + "\n",
      );
    } catch {
      /* best-effort — worst case we discard until the natural result */
    }
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

    if (process.env.JARVIS_BRAIN_DEBUG) {
      const se = (e.event ?? {}) as Record<string, unknown>;
      const detail = type === "stream_event" ? `/${se.type}` : "";
      console.log(`[cli-brain dbg] ${type}${detail} ${line.slice(0, 140)}`);
    }

    // startup + failure visibility: init tells us the child is actually up;
    // an error-subtyped result would otherwise vanish into the discard path
    if (type === "system" && e.subtype === "init") {
      console.log(`[cli-brain] child ready (model ${(e as { model?: string }).model ?? "?"})`);
    } else if (type === "result" && typeof e.subtype === "string" && e.subtype !== "success") {
      console.error(`[cli-brain] result ${e.subtype}: ${String(e.result ?? "").slice(0, 200)}`);
    }

    if (type === "stream_event") {
      const se = (e.event ?? {}) as Record<string, unknown>;
      const index = typeof se.index === "number" ? se.index : -1;

      if (se.type === "content_block_start") {
        const block = (se.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use" && typeof block.name === "string") {
          if (typeof block.id === "string") this.toolNames.set(block.id, block.name);
          if (block.name === SAY_TOOL) {
            // speech begins: stream its input's text field as it generates
            this.sayIndex = index;
            this.sayExtractor = new SayTextExtractor();
          } else {
            if (turn && !turn.discarding) turn.cb.onToolCall?.(block.name);
            this.opts.onToolCall?.(block.name);
          }
        }
        return;
      }

      if (se.type === "content_block_delta") {
        const delta = (se.delta ?? {}) as Record<string, unknown>;
        if (
          delta.type === "input_json_delta" &&
          index === this.sayIndex &&
          this.sayExtractor &&
          typeof delta.partial_json === "string"
        ) {
          const text = this.sayExtractor.push(delta.partial_json);
          if (text && turn && !turn.discarding) {
            turn.saySeen = true;
            turn.fullText += text;
            turn.cb.onTextDelta(text);
          }
        } else if (delta.type === "text_delta" && typeof delta.text === "string") {
          // Plain text is the model's private workspace now — never spoken,
          // but streamed to the stage as the dim inner-monologue line.
          if (turn && !turn.discarding) {
            turn.scratch += delta.text;
            turn.cb.onThought?.(delta.text);
          }
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          // extended thinking (when enabled) is inner monologue too
          if (turn && !turn.discarding) turn.cb.onThought?.(delta.thinking);
        }
        return;
      }

      if (se.type === "content_block_stop" && index === this.sayIndex) {
        this.sayIndex = null;
        this.sayExtractor = null;
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
          const name =
            typeof b.tool_use_id === "string" ? this.toolNames.get(b.tool_use_id) ?? "" : "";
          if (name !== SAY_TOOL) this.opts.onToolResult?.(name, extractText(b.content));
        }
      }
      return;
    }

    if (type === "result") {
      // turn complete (or the discarded remnant of an interrupted one)
      if (turn && !turn.discarding) {
        // Deliberate silence is a valid reply (blank input, nothing to add).
        // Scratch text is NEVER spoken — an earlier speak-the-scratch fallback
        // surfaced the model's private "staying quiet" notes aloud. Log only.
        if (!turn.saySeen && turn.scratch.trim()) {
          console.log(`[cli-brain] silent turn; scratch: ${turn.scratch.trim().slice(0, 200)}`);
        }
        turn.resolve({ fullText: turn.fullText, aborted: false });
      }
      this.active = null;
      this.sayIndex = null;
      this.sayExtractor = null;
      this.toolNames.clear();
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

// Incremental extractor for the say tool's streamed input: pulls the VALUE of
// the "text" property out of partial JSON fragments as they arrive, decoding
// string escapes, so TTS starts on the first sentence of a say — not when the
// call completes. Handles exactly the say schema ({"text": "..."}), nothing more.
export class SayTextExtractor {
  private state: "pre" | "in" | "done" = "pre";
  private pre = ""; // buffered prefix while hunting for the key (chunk-split safe)
  private esc = false; // previous char was a backslash
  private uni: string | null = null; // pending \uXXXX hex digits

  push(chunk: string): string {
    if (this.state === "done") return "";
    if (this.state === "pre") {
      this.pre += chunk;
      const m = this.pre.match(/"text"\s*:\s*"/);
      if (!m) return "";
      const rest = this.pre.slice(m.index! + m[0].length);
      this.pre = "";
      this.state = "in";
      return this.consume(rest);
    }
    return this.consume(chunk);
  }

  private consume(s: string): string {
    let out = "";
    for (const ch of s) {
      if (this.uni !== null) {
        this.uni += ch;
        if (this.uni.length === 4) {
          out += String.fromCharCode(parseInt(this.uni, 16));
          this.uni = null;
        }
        continue;
      }
      if (this.esc) {
        this.esc = false;
        if (ch === "u") this.uni = "";
        else out += ESCAPES[ch] ?? ch;
        continue;
      }
      if (ch === "\\") {
        this.esc = true;
        continue;
      }
      if (ch === '"') {
        this.state = "done";
        break;
      }
      out += ch;
    }
    return out;
  }
}

const ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/",
};

const CLI_PREAMBLE = `IMPORTANT: You are NOT a coding assistant in this session; ignore any \
default coding-agent framing — everything below defines who you are. Rafe hears ONLY text \
you pass to the say tool; plain text you output is never seen or heard, so never answer in \
plain text. The Bash tool is the shell referred to below. Do not use Edit, Write, \
NotebookEdit, or todo tools; wiki edits go only through the wiki MCP tools.\n\n`;
