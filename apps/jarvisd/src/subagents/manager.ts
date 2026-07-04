import { boundText, type ActivityDraft, type ThinkingLevel } from "@jarvis/protocol";
import { redactSecrets } from "../mcp/manager.js";
import { PersistentClaude, type CliServerSpec } from "../brain/persistent-claude.js";

// Interactive tier-2 subagents (design §II.5): a background task is no longer
// a fire-and-forget one-shot `claude -p` — it is a PERSISTENT stream-json child
// (the same process shape as tier-1's warm brain) that jarvisd holds open, can
// write follow-up instructions to, and parses at full fidelity into the
// activity log tagged agent:"sub_N". "idle" (instruction done, process warm,
// awaiting a follow-up) is distinct from "closed" (process gone) — that
// distinction IS the interactivity.

// §II.6 toolset — the same INTERACTION model as tier-1 subagents, not the same
// grants: read and run broadly, gate only the reviewed writers. wiki_commit and
// browser hands never enter this list; every world-write still lands as a diff
// Rafe confirms. Bash is on by default (Rafe's call, 2026-07-03) — unattended
// but OBSERVABLE: every command and its output streams into Activity, and
// subagent_stop is one click. SUBAGENT_BASH=off / config reverts per session.
const SUB_ALLOWED_BASE = [
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "mcp__wiki__wiki_search",
  "mcp__wiki__wiki_read",
  "mcp__wiki__wiki_list",
  "mcp__wiki__wiki_propose_edit",
];
const SUB_DISALLOWED_BASE = [
  "Edit",
  "Write",
  "NotebookEdit",
  "TodoWrite",
  "mcp__wiki__wiki_commit",
  "mcp__wiki__wiki_context",
];

const SUBAGENT_SYSTEM = `You are Jarvis's background worker — a persistent subagent. Complete \
each instruction using your tools, then reply with a concise plain-text report of what you did \
and found; the report is delivered to Jarvis and Rafe, it is not a performance. You stay warm \
after reporting and may receive follow-up instructions or questions in this same conversation — \
answer them directly, with your prior work as context. You may stage wiki edits with \
wiki_propose_edit; Rafe reviews every diff and you cannot commit. If you have a shell, read, \
search, and run what you need without asking, but avoid destructive or hard-to-reverse commands \
(deleting files, killing processes, git push, installs) unless the instruction explicitly \
requires them, and never touch the wiki directory through the shell — wiki tools only. No stage \
markup; plain text only.`;

// Lifecycle bounds: the old 15-minute hard timeout becomes an idle-TTL (reap a
// warm child nobody is talking to) plus a hard max lifetime, plus explicit stop.
const SUBAGENT_CAP = 3;
const IDLE_TTL_MS = 10 * 60_000;
const MAX_LIFE_MS = 60 * 60_000;

export type SubagentState = "starting" | "working" | "idle" | "closed" | "failed" | "timed-out";

export interface SubagentReport {
  subId: string;
  label: string;
  instruction: string;
  report: string;
  proposals: string[]; // wiki proposal ids staged during this instruction
}

export interface SubagentSnapshot {
  id: string;
  label: string;
  model: string;
  state: SubagentState;
  session: string;
  instruction: string;
  elapsedMs: number;
  toolCount: number;
  lastLine: string;
}

interface Subagent {
  id: string;
  label: string;
  model: string;
  session: string;
  parentTurn?: string;
  state: SubagentState;
  child: PersistentClaude;
  queued: string[];
  instruction: string;
  lastReport: string;
  toolCount: number;
  lastLine: string;
  startedAt: number;
  lastActiveAt: number;
  proposals: string[];
  openInputs: Map<string, string>; // callId → captured input (for resolve re-emit)
  thinkBuf: string;
  thinkTimer: ReturnType<typeof setTimeout> | null;
}

export interface SubagentManagerOptions {
  binary?: string;
  // read at each start(): settings bind the NEXT subagent; running ones keep
  // their spawn-time model until they close (exactly like tier-1's deferred restart)
  model: () => string;
  thinking: () => ThinkingLevel;
  bashAllowed: () => boolean;
  servers: CliServerSpec[]; // wiki only — web rides the built-in tools
  // single appender: stamps id/at/session, persists, broadcasts
  emit: (draft: ActivityDraft) => void;
  onReport: (report: SubagentReport) => void;
}

export class SubagentManager {
  private counter = 0;
  private pool = new Map<string, Subagent>();
  private reaper: ReturnType<typeof setInterval>;

  constructor(private readonly opts: SubagentManagerOptions) {
    this.reaper = setInterval(() => this.reap(), 60_000);
    this.reaper.unref?.();
  }

  // ── model- and human-facing verbs (§II.5) ────────────────────
  start(task: string, label?: string, ctx?: { session?: string; parentTurn?: string }): string {
    const live = [...this.pool.values()].filter((s) => isLive(s.state));
    if (live.length >= SUBAGENT_CAP) {
      throw new Error(
        `at capacity: ${live.length} live subagents (${live.map((s) => s.id).join(", ")}). ` +
          `Stop one with subagent_stop or wait for one to finish.`,
      );
    }
    const id = `sub_${++this.counter}`;
    const model = this.opts.model();
    const bash = this.opts.bashAllowed();
    const sub: Subagent = {
      id,
      label: sanitizeLabel(label) ?? id,
      model,
      session: ctx?.session ?? "",
      parentTurn: ctx?.parentTurn,
      state: "starting",
      child: null as unknown as PersistentClaude, // assigned below
      queued: [],
      instruction: task,
      lastReport: "",
      toolCount: 0,
      lastLine: "",
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      proposals: [],
      openInputs: new Map(),
      thinkBuf: "",
      thinkTimer: null,
    };
    sub.child = new PersistentClaude(
      {
        binary: this.opts.binary,
        label: id,
        model,
        thinking: this.opts.thinking(),
        appendSystemPrompt: SUBAGENT_SYSTEM,
        servers: this.opts.servers,
        allowedTools: bash ? [...SUB_ALLOWED_BASE, "Bash"] : SUB_ALLOWED_BASE,
        disallowedTools: bash ? SUB_DISALLOWED_BASE : [...SUB_DISALLOWED_BASE, "Bash"],
      },
      this.childEvents(sub),
    );
    this.pool.set(id, sub);
    this.emitSub(sub, {
      op: "start",
      label: sub.label,
      model,
      state: "starting",
      instruction: boundText(task, 2000, 1000),
    });
    this.instruct(sub, task);
    return id;
  }

  // Async by design: returns immediately; the answer surfaces via the idle
  // channel + Activity, never inline in a tier-1 turn (§II.7).
  send(id: string, message: string): string {
    const sub = this.mustGet(id);
    if (!isLive(sub.state)) {
      throw new Error(`${id} is ${sub.state} — it can no longer take messages. Start a new subagent.`);
    }
    if (sub.state === "working" || sub.state === "starting") {
      sub.queued.push(message);
      this.emitSub(sub, { op: "instruct", state: sub.state, instruction: boundText(message, 2000, 1000), summary: "queued behind current instruction" });
      return `queued for ${id} (currently ${sub.state}); it will pick this up when the current instruction finishes.`;
    }
    this.instruct(sub, message);
    return `sent to ${id}; the answer will arrive in the conversation when it's ready.`;
  }

  status(id?: string): string {
    if (id) return this.describe(this.mustGet(id));
    const subs = [...this.pool.values()];
    if (subs.length === 0) return "no subagents this session.";
    return subs.map((s) => this.describe(s)).join("\n");
  }

  snapshots(): SubagentSnapshot[] {
    return [...this.pool.values()].map((s) => ({
      id: s.id,
      label: s.label,
      model: s.model,
      state: s.state,
      session: s.session,
      instruction: s.instruction,
      elapsedMs: Date.now() - s.startedAt,
      toolCount: s.toolCount,
      lastLine: s.lastLine,
    }));
  }

  result(id: string): string {
    const sub = this.mustGet(id);
    if (!sub.lastReport) return `${id} has not produced a report yet (state: ${sub.state}).`;
    return sub.lastReport;
  }

  stop(id: string): string {
    const sub = this.mustGet(id);
    if (!isLive(sub.state)) return `${id} is already ${sub.state}.`;
    this.close(sub, "closed", "stopped on request");
    return `stopped ${id}.`;
  }

  // The idle backstop and endSession query this instead of guessing (§7): a
  // session must not end from idleness while its subagents are still working.
  hasBusy(session?: string): boolean {
    return [...this.pool.values()].some(
      (s) =>
        (s.state === "working" || s.state === "starting") &&
        (session === undefined || s.session === session),
    );
  }

  // Is a subagent with this label actively generating (starting/working)?
  // Ambient drafts key off this so they never stack: two background Opus
  // children generating at once share the subscription and blow up the
  // foreground voice turn's first-token latency (observed: 3s → 20s+).
  hasWorkingLabel(label: string): boolean {
    const want = sanitizeLabel(label);
    return [...this.pool.values()].some(
      (s) => s.label === want && (s.state === "working" || s.state === "starting"),
    );
  }

  dispose(): void {
    clearInterval(this.reaper);
    for (const sub of this.pool.values()) {
      if (isLive(sub.state)) this.close(sub, "closed", "daemon shutdown");
    }
  }

  // ── internals ────────────────────────────────────────────────
  private mustGet(id: string): Subagent {
    const sub = this.pool.get(id);
    if (!sub) {
      const known = [...this.pool.keys()].join(", ") || "none";
      throw new Error(`no such subagent: ${id} (known: ${known})`);
    }
    return sub;
  }

  private describe(s: Subagent): string {
    const mins = Math.round((Date.now() - s.startedAt) / 60_000);
    const parts = [
      `${s.id} [${s.state}]`,
      s.label !== s.id ? `"${s.label}"` : "",
      `${s.model}`,
      `${mins}m`,
      `${s.toolCount} tool calls`,
      s.state === "working" ? `on: ${s.instruction.slice(0, 80)}` : "",
      s.lastLine ? `last: ${s.lastLine.slice(0, 100)}` : "",
    ];
    return parts.filter(Boolean).join(" · ");
  }

  private instruct(sub: Subagent, task: string): void {
    sub.instruction = task;
    sub.proposals = [];
    sub.state = "working";
    sub.lastActiveAt = Date.now();
    // The instruction (which may inline a distilled transcript — Layer 3) goes
    // to the child on STDIN via stream-json, never argv (argv is world-readable).
    const ok = sub.child.sendUser(task);
    if (!ok) {
      this.close(sub, "failed", "child would not accept input");
      return;
    }
    this.emitSub(sub, {
      op: "instruct",
      state: "working",
      instruction: boundText(task, 2000, 1000),
    });
  }

  private childEvents(sub: Subagent) {
    return {
      onToolInput: (callId: string, name: string, input: unknown) => {
        const shortName = name.replace(/^mcp__\w+?__/, "");
        const inputText = boundText(redactSecrets(safeJson(input)), 2000, 1000);
        sub.openInputs.set(callId, inputText);
        sub.toolCount++;
        sub.lastLine = `${shortName} ${inputText.slice(0, 80)}`;
        sub.lastActiveAt = Date.now();
        this.emitSub(sub, undefined, {
          kind: "tool",
          callId,
          name: shortName,
          input: inputText,
          status: "running",
          agent: sub.id,
          parent: sub.parentTurn,
        });
      },
      onToolResult: (callId: string, name: string, output: string, isError: boolean, durationMs: number) => {
        const shortName = name.replace(/^mcp__\w+?__/, "");
        const inputText = sub.openInputs.get(callId);
        sub.openInputs.delete(callId);
        sub.lastActiveAt = Date.now();
        if (/wiki_propose_edit$/.test(name)) {
          const m = output.match(/proposal (\w+)/);
          if (m) sub.proposals.push(m[1]!);
        }
        this.emitSub(sub, undefined, {
          kind: "tool",
          callId,
          name: shortName,
          input: inputText,
          status: isError ? "error" : "ok",
          output: boundText(redactSecrets(output), 10_000, 4_000),
          durationMs,
          agent: sub.id,
          parent: sub.parentTurn,
        });
      },
      onText: (delta: string) => this.pushThink(sub, delta),
      onThinking: (delta: string) => this.pushThink(sub, delta),
      onResult: (text: string, subtype: string) => {
        this.flushThink(sub);
        sub.lastActiveAt = Date.now();
        const failed = subtype !== "success";
        sub.lastReport = text || sub.lastReport;
        sub.lastLine = text.slice(0, 100);
        const finished = sub.instruction;
        const proposals = sub.proposals.splice(0);
        this.emitSub(sub, {
          op: failed ? "error" : "done",
          state: "idle",
          instruction: boundText(finished, 400, 200),
          summary: boundText(text, 1000, 500),
        });
        this.opts.onReport({
          subId: sub.id,
          label: sub.label,
          instruction: finished,
          report: failed ? `subagent ${sub.id} errored (${subtype}): ${text}` : text,
          proposals,
        });
        const next = sub.queued.shift();
        if (next !== undefined) this.instruct(sub, next);
        else sub.state = "idle";
      },
      onExit: (code: number | null) => {
        this.flushThink(sub);
        if (!isLive(sub.state)) return; // deliberate stop/reap already recorded
        const wasWorking = sub.state === "working" || sub.state === "starting";
        sub.state = "failed";
        this.emitSub(sub, {
          op: "error",
          state: "failed",
          summary: `process exited (${code ?? "?"})${wasWorking ? " mid-instruction" : ""}`,
        });
        if (wasWorking) {
          this.opts.onReport({
            subId: sub.id,
            label: sub.label,
            instruction: sub.instruction,
            report: `background subagent ${sub.id} died (exit ${code ?? "?"}) before finishing.`,
            proposals: sub.proposals.splice(0),
          });
        }
      },
    };
  }

  // §II.2: think events are debounced TAIL snapshots (last ~600 chars), the
  // same shape as tier-1's thought line — raw deltas would staircase.
  private pushThink(sub: Subagent, delta: string): void {
    sub.thinkBuf += delta;
    sub.lastActiveAt = Date.now();
    if (sub.thinkTimer) return;
    sub.thinkTimer = setTimeout(() => {
      sub.thinkTimer = null;
      this.flushThink(sub);
    }, 250);
  }

  private flushThink(sub: Subagent): void {
    if (sub.thinkTimer) {
      clearTimeout(sub.thinkTimer);
      sub.thinkTimer = null;
    }
    const tail = sub.thinkBuf.slice(-600).trimStart();
    if (!tail.trim()) return;
    this.emitSub(sub, undefined, {
      kind: "think",
      text: tail,
      agent: sub.id,
      parent: sub.parentTurn,
    });
  }

  private close(sub: Subagent, state: "closed" | "failed" | "timed-out", why: string): void {
    sub.state = state; // set BEFORE kill so onExit sees a deliberate close
    sub.child.kill();
    this.emitSub(sub, { op: "closed", state, summary: why });
  }

  private reap(): void {
    const now = Date.now();
    for (const sub of this.pool.values()) {
      if (!isLive(sub.state)) continue;
      if (now - sub.startedAt > MAX_LIFE_MS) {
        this.close(sub, "timed-out", `max lifetime (${MAX_LIFE_MS / 60_000}m) reached`);
      } else if (sub.state === "idle" && now - sub.lastActiveAt > IDLE_TTL_MS) {
        this.close(sub, "closed", `idle for ${IDLE_TTL_MS / 60_000}m`);
      }
    }
  }

  // Emit either a subagent lifecycle event (first arg) or an arbitrary draft
  // (second arg) — both tagged with this subagent's identity.
  private emitSub(
    sub: Subagent,
    lifecycle?: {
      op: "start" | "instruct" | "status" | "done" | "error" | "closed";
      label?: string;
      model?: string;
      state?: string;
      instruction?: string;
      summary?: string;
    },
    draft?: ActivityDraft,
  ): void {
    if (lifecycle) {
      this.opts.emit({
        kind: "subagent",
        subId: sub.id,
        label: sub.label,
        model: sub.model,
        agent: sub.id,
        parent: sub.parentTurn,
        ...lifecycle,
      });
    }
    if (draft) this.opts.emit(draft);
  }
}

function isLive(state: SubagentState): boolean {
  return state === "starting" || state === "working" || state === "idle";
}

function sanitizeLabel(label?: string): string | undefined {
  const clean = label?.replace(/\s+/g, " ").trim().slice(0, 60);
  return clean || undefined;
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
