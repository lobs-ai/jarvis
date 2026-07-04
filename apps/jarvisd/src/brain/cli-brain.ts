import type { ThinkingLevel } from "@jarvis/protocol";
import { buildSystemPrompt } from "./prompt.js";
import { snapshotWiki } from "./wiki-index.js";
import type { BrainPort, BrainCallbacks } from "./port.js";
import {
  PersistentClaude,
  type CliServerSpec,
} from "./persistent-claude.js";

export type { CliServerSpec } from "./persistent-claude.js";

// Speech-as-tool (Rafe's redesign): the model is silent by default and speaks
// by calling this tool. jarvisd streams the tool's input text to the compiler
// from input_json_delta events — speech starts before the call even completes,
// and the stub server acks instantly so talking overlaps working.
const SAY_TOOL = "mcp__speech__say";

export interface CliBrainOptions {
  binary?: string;
  model: string;
  thinking?: ThinkingLevel;
  // read at child spawn so a wiki move lands in the prompt after a reset
  wikiDir?: () => string;
  servers: CliServerSpec[];
  // Tools Claude Code may call directly (say, shell, reads, wiki proposals).
  // Mutating wiki/browser tools are excluded — jarvisd gates those (design §Security).
  allowedTools: string[];
  disallowedTools: string[];
  // out-of-turn hook (gateProposal): fires for every non-say tool result
  onToolResult?: (name: string, text: string) => void;
  facts: () => string | null;
}

// Thinking: the five named levels are Claude Code's own --effort strings
// (low/medium/high/xhigh/max). "off" is ours — MAX_THINKING_TOKENS=0 disables
// extended thinking entirely (opus defaults it ON — measured ~9s dead air).

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
// The child-spawn + stream parse guts live in PersistentClaude (shared with
// tier-2 subagents); this class owns turn lifecycle and the say-tool voice.
export class CliBrain implements BrainPort {
  readonly kind = "cli" as const;
  private pc: PersistentClaude | null = null;
  private active: ActiveTurn | null = null;
  private busy = false;
  private freeWaiters: Array<() => void> = [];
  private sayIndex: number | null = null; // content-block index of an in-flight say
  private sayExtractor: SayTextExtractor | null = null;
  // settings-mutable; baked into the child at spawn, so changes need reset()
  private model: string;
  private thinking: ThinkingLevel;

  constructor(private readonly opts: CliBrainOptions) {
    this.model = opts.model;
    this.thinking = opts.thinking ?? "off";
  }

  private ensureChild(): PersistentClaude {
    if (this.pc?.alive) return this.pc;
    const wikiDir = this.opts.wikiDir?.();
    const pc = new PersistentClaude(
      {
        binary: this.opts.binary,
        label: "cli-brain",
        model: this.model,
        thinking: this.thinking,
        appendSystemPrompt:
          CLI_PREAMBLE +
          buildSystemPrompt("say-tool", wikiDir, wikiDir ? snapshotWiki(wikiDir) : undefined),
        servers: this.opts.servers,
        allowedTools: this.opts.allowedTools,
        disallowedTools: this.opts.disallowedTools,
      },
      {
        onToolStart: (callId, name, index) => {
          if (name === SAY_TOOL) {
            // speech begins: stream its input's text field as it generates
            this.sayIndex = index;
            this.sayExtractor = new SayTextExtractor();
            return;
          }
          const turn = this.active;
          if (turn && !turn.discarding) turn.cb.onToolStart?.(callId, name);
        },
        onToolInputDelta: (index, _callId, _name, partial) => {
          if (index !== this.sayIndex || !this.sayExtractor) return;
          const text = this.sayExtractor.push(partial);
          const turn = this.active;
          if (text && turn && !turn.discarding) {
            turn.saySeen = true;
            turn.fullText += text;
            turn.cb.onTextDelta(text);
          }
        },
        onToolInput: (callId, name, input) => {
          if (name === SAY_TOOL) {
            this.sayIndex = null;
            this.sayExtractor = null;
            return;
          }
          const turn = this.active;
          if (turn && !turn.discarding) turn.cb.onToolCall?.(callId, name, input);
        },
        onToolResult: (callId, name, output, isError, durationMs) => {
          if (name === SAY_TOOL) return;
          const turn = this.active;
          if (turn && !turn.discarding) {
            turn.cb.onToolResult?.(callId, name, output, isError, durationMs);
          }
          this.opts.onToolResult?.(name, output);
        },
        onText: (delta) => {
          // Plain text is the model's private workspace — never spoken, but
          // streamed to the stage as the dim inner-monologue line.
          const turn = this.active;
          if (turn && !turn.discarding) {
            turn.scratch += delta;
            turn.cb.onThought?.(delta);
          }
        },
        onThinking: (delta) => {
          // extended thinking (when enabled) is inner monologue too
          const turn = this.active;
          if (turn && !turn.discarding) turn.cb.onThought?.(delta);
        },
        onResult: () => {
          // turn complete (or the discarded remnant of an interrupted one)
          const turn = this.active;
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
          this.setBusy(false);
        },
        onExit: () => this.failActive(),
      },
    );
    this.pc = pc;
    return pc;
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
    const pc = this.ensureChild();
    this.setBusy(true);

    const facts = this.opts.facts();
    const content = facts ? `<facts>\n${facts}\n</facts>\n\n${userText}` : userText;

    return new Promise<{ fullText: string; aborted: boolean }>((resolve) => {
      // set active BEFORE writing so a fast first delta isn't dropped
      const turn: ActiveTurn = {
        cb, resolve, fullText: "", scratch: "", saySeen: false, aborted: false, discarding: false,
      };
      this.active = turn;
      pc.sendUser(content);
      const onAbort = (): void => {
        // Barge-in: stop forwarding deltas immediately, tell the child to stop
        // generating, and hand control back. Whatever remnant still streams is
        // discarded until its `result`; the interrupt makes that arrive fast
        // instead of after the full agentic loop.
        turn.aborted = true;
        turn.discarding = true;
        pc.interrupt();
        signal.removeEventListener("abort", onAbort);
        resolve({ fullText: turn.fullText, aborted: true });
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    });
  }

  recordInterrupted(): void {
    // Claude Code owns history; the process saw its own partial output. The
    // next turn is prefixed with the interruption note by Session, which is
    // enough for the model to reconcile.
  }

  configure(patch: { model?: string; thinking?: ThinkingLevel }): void {
    if (patch.model) this.model = patch.model;
    if (patch.thinking) this.thinking = patch.thinking;
  }

  // Spawn the child now (boot / right after reset) so MCP servers connect
  // before the first turn — a turn racing a cold child found say unregistered.
  warm(): void {
    this.ensureChild().ensure();
  }

  // Fresh conversation: kill the warm child (its process IS the history) and
  // let the next turn spawn a new one with the current model/thinking/prompt.
  reset(): void {
    const pc = this.pc;
    this.pc = null; // detach first so the exit handler can't double-fail
    pc?.kill();
    this.failActive();
    this.sayIndex = null;
    this.sayExtractor = null;
  }

  dispose(): void {
    this.pc?.kill();
    this.pc = null;
  }
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
