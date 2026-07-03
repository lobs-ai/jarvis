import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { JARVIS_HOME } from "../config.js";

const SESSIONS_DIR = join(JARVIS_HOME, "sessions");
const FACTS_PATH = join(JARVIS_HOME, "facts.md");

export interface TranscriptEvent {
  at: string;
  kind: "user" | "assistant" | "warning" | "interrupt" | "system";
  text: string;
}

// Jarvis's own operational memory — deliberately NOT the wiki (design §memory).
export class MemoryStore {
  private sessionFile: string;

  constructor(retentionDays: number) {
    mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.sessionFile = join(SESSIONS_DIR, `${stamp}.jsonl`);
    this.prune(retentionDays);
  }

  append(event: TranscriptEvent): void {
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.sessionFile, line, { mode: 0o600 });
    chmodSync(this.sessionFile, 0o600);
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

  private prune(retentionDays: number): void {
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    for (const name of readdirSync(SESSIONS_DIR)) {
      const p = join(SESSIONS_DIR, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* pruning is best-effort */
      }
    }
  }
}
