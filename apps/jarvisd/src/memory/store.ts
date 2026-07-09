import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ActivityEvent, type ActivityDraft } from "@jarvis/protocol";
import { JARVIS_HOME } from "../config.js";

const SESSIONS_DIR = join(JARVIS_HOME, "sessions");
const CURRENT_PATH = join(SESSIONS_DIR, "current");
const FACTS_PATH = join(JARVIS_HOME, "facts.md");

// How many recent events stay in memory for the reconnect replay tail — the
// JSONL is the full record; the stage only needs recent history on connect.
const RECENT_CAP = 400;

// Jarvis's own operational memory — deliberately NOT the wiki (design §memory).
//
// Post-M4 Layer 1 + §II.2: one ActivityEvent JSONL per session is THE durable
// record (conversation, activity, and replay are three projections of it). The
// session has a STABLE id minted once and reused across daemon restarts
// (persisted to sessions/current), so a restart appends to the same transcript
// instead of silently forking it. A session ends only through endSession()
// (spoken phrase, stage button, or the idle backstop), which stamps the file
// closed and rotates to a new id IN PLACE on this live instance — the store is
// constructed once at boot and never again in-process.
export class MemoryStore {
  private file!: string;
  private id!: string;
  private eventSeq = 0; // monotonic within the session — the ordering key
  private turnSeq = 0; // turnIds are <sessionId>-<n>, unique across restarts
  private recent: ActivityEvent[] = [];
  // turnIds of heartbeat turns this session — their events are invisible to
  // the idle clock (awareness-heartbeat §2.9 Q6): a session kept "alive" only
  // by its own heartbeats must still rotate, or ambient drafting never fires.
  private heartbeatTurns = new Set<string>();
  lastEventAt = Date.now();

  constructor(
    private readonly retentionDays: number,
    idleEndMs: number,
  ) {
    mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    const resumed = this.tryResume(idleEndMs);
    if (!resumed) this.openFresh();
    this.prune();
  }

  get sessionId(): string {
    return this.id;
  }

  get hasTurns(): boolean {
    return this.turnSeq > 0;
  }

  // Crash-resume vs fresh-start (§7): a kill -9 leaves `current` behind with no
  // session.end stamp. Resume it — unless its last event is older than the idle
  // backstop, in which case close it (stamped now) and start fresh rather than
  // resurrecting a dead session.
  private tryResume(idleEndMs: number): boolean {
    let id: string;
    try {
      id = readFileSync(CURRENT_PATH, "utf8").trim();
    } catch {
      return false;
    }
    if (!id || !/^[\w.-]+$/.test(id)) return false;
    const file = join(SESSIONS_DIR, `${id}.jsonl`);
    if (!existsSync(file)) return false;

    const events: ActivityEvent[] = readEvents(file);
    const last = events[events.length - 1];
    const lastAt = last ? Date.parse(last.at) : statSync(file).mtimeMs;
    if (!Number.isNaN(lastAt) && Date.now() - lastAt > idleEndMs) {
      // dead session: stamp it closed in place, then let openFresh take over
      const end: ActivityEvent = {
        id: events.length + 1,
        at: new Date().toISOString(),
        session: id,
        agent: "main",
        kind: "session",
        phase: "end",
        reason: "idle",
      };
      appendFileSync(file, JSON.stringify(end) + "\n", { mode: 0o600 });
      unlinkSync(CURRENT_PATH);
      return false;
    }

    this.id = id;
    this.file = file;
    this.eventSeq = events.length;
    this.turnSeq = maxTurnSeq(events, id);
    this.recent = events.slice(-RECENT_CAP);
    this.lastEventAt = Number.isNaN(lastAt) ? Date.now() : lastAt;
    console.log(`[memory] resumed session ${id} (${events.length} events, turn ${this.turnSeq})`);
    return true;
  }

  private openFresh(): void {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
    this.id = `${stamp}-${randomBytes(2).toString("hex")}`;
    this.file = join(SESSIONS_DIR, `${this.id}.jsonl`);
    this.eventSeq = 0;
    this.turnSeq = 0;
    this.recent = [];
    this.heartbeatTurns.clear();
    writeFileSync(CURRENT_PATH, this.id + "\n", { mode: 0o600 });
    this.append({ kind: "session", phase: "begin", agent: "main" });
  }

  // Stamp id/at/session and persist. Returns the full event so the caller can
  // put the exact on-disk record on the wire (one event, one log).
  append(draft: ActivityDraft): ActivityEvent {
    const event = {
      ...draft,
      id: ++this.eventSeq,
      at: new Date().toISOString(),
      session: this.id,
    } as ActivityEvent;
    appendFileSync(this.file, JSON.stringify(event) + "\n", { mode: 0o600 });
    chmodSync(this.file, 0o600);
    this.recent.push(event);
    if (this.recent.length > RECENT_CAP) this.recent.splice(0, this.recent.length - RECENT_CAP);
    if (event.kind === "turn" && event.phase === "begin" && event.source === "heartbeat" && event.turn)
      this.heartbeatTurns.add(event.turn);
    if (!(event.turn && this.heartbeatTurns.has(event.turn))) this.lastEventAt = Date.now();
    return event;
  }

  // Turn ids are <sessionId>-<n> from a counter persisted with the session
  // (recovered from the JSONL on resume) — a per-process counter reset to t1 on
  // restart and collided live t3:e1 with a replayed t3:e1 on the stage.
  nextTurnId(): string {
    return `${this.id}-${++this.turnSeq}`;
  }

  // Bounded tail for the reconnect replay / activity backfill.
  recentEvents(limit = RECENT_CAP): ActivityEvent[] {
    return this.recent.slice(-limit);
  }

  // End the session and rotate to a fresh id in place (there is no
  // re-construction — this instance lives as long as the daemon).
  endSession(reason: "phrase" | "button" | "idle" | "shutdown"): string {
    const closed = this.id;
    this.append({ kind: "session", phase: "end", reason, agent: "main" });
    try {
      unlinkSync(CURRENT_PATH);
    } catch {
      /* already gone */
    }
    this.openFresh();
    return closed;
  }

  listSessions(): Array<{ id: string; mtimeMs: number; live: boolean }> {
    const out: Array<{ id: string; mtimeMs: number; live: boolean }> = [];
    for (const name of readdirSync(SESSIONS_DIR)) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      try {
        out.push({ id, mtimeMs: statSync(join(SESSIONS_DIR, name)).mtimeMs, live: id === this.id });
      } catch {
        /* raced a prune */
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  readSession(id: string): ActivityEvent[] {
    if (!/^[\w.-]+$/.test(id)) return [];
    const file = join(SESSIONS_DIR, `${id}.jsonl`);
    if (!existsSync(file)) return [];
    return readEvents(file);
  }

  readFacts(): string | null {
    if (!existsSync(FACTS_PATH)) return null;
    return readFileSync(FACTS_PATH, "utf8");
  }

  appendFact(fact: string): void {
    const line = `- ${fact.replace(/\n+/g, " ").trim()}\n`;
    appendFileSync(FACTS_PATH, line, { mode: 0o600 });
  }

  // TTS pronunciation substitutions from facts.md lines like:  say: MemCore => mem core
  pronunciationMap(): Array<[string, string]> {
    const facts = this.readFacts();
    if (!facts) return [];
    const map: Array<[string, string]> = [];
    for (const line of facts.split("\n")) {
      const m = line.match(/^say:\s*(.+?)\s*=>\s*(.+)\s*$/);
      if (m) map.push([m[1]!, m[2]!]);
    }
    return map;
  }

  // Prune by file mtime (a closed session's mtime is its end stamp), never the
  // live session or the `current` pointer.
  private prune(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 3600 * 1000;
    for (const name of readdirSync(SESSIONS_DIR)) {
      if (name === "current" || name === `${this.id}.jsonl`) continue;
      const p = join(SESSIONS_DIR, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* pruning is best-effort */
      }
    }
  }
}

// Parse a session file, skipping lines that don't validate (pre-ActivityEvent
// session files from before this format simply read as empty).
function readEvents(file: string): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = ActivityEvent.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function maxTurnSeq(events: ActivityEvent[], sessionId: string): number {
  let max = 0;
  const prefix = `${sessionId}-`;
  for (const e of events) {
    if (!e.turn?.startsWith(prefix)) continue;
    const n = Number(e.turn.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}
