import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";

export const JARVIS_HOME = join(homedir(), ".jarvis");

const ConfigSchema = z.object({
  port: z.number().int().default(7430),
  model_tier1: z.string().default("claude-opus-4-8"), // Rafe's call: opus over sonnet's latency edge
  model_tier2: z.string().default("claude-fable-5"),
  // extended-thinking effort for tier-1: the CLI's --effort levels, plus our
  // "off" (MAX_THINKING_TOKENS=0 — measured 9s→2s ttft on opus)
  thinking: z.enum(["off", "low", "medium", "high", "xhigh", "max"]).default("off"),
  // tier-2 has no voice-latency budget — deliberation is free there (Rafe's
  // call: opus + xhigh). Applies live; each background task is a fresh child.
  thinking_tier2: z.enum(["off", "low", "medium", "high", "xhigh", "max"]).default("xhigh"),
  stt_url: z.string().default("http://127.0.0.1:7423"),
  tts_url: z.string().default("http://127.0.0.1:7422"),
  tts_voice: z.string().default("default"),
  retention_days: z.number().int().default(30),
  wiki_dir: z.string().default(join(homedir(), "wiki")),
  // ── post-M4 ──────────────────────────────────────────────────
  // Idle backstop: a session Rafe walked away from ends itself after this many
  // minutes of quiet (deferred while background subagents are still working).
  idle_session_end_min: z.number().default(30),
  // Layer 3: fire a tier-2 draft task on session end that may PROPOSE (never
  // commit) wiki edits about Rafe. Flag exists so the feature can be dark-launched.
  ambient_drafting: z.boolean().default(true),
  // Layer 4: when the gate is ENABLED, an idle voice utterance becomes a turn
  // only if it starts with this word ("jarvis" / "hey jarvis"). Confirmations
  // and barge-in are never gated. The enable/disable switch is separate from
  // the word (Rafe's call: sometimes just talk, sometimes always-on presence) —
  // it lives in the stage footer next to Mic/Voice and defaults OFF.
  wake_word: z.string().default("jarvis"),
  wake_enabled: z.boolean().default(false),
  // §II.6: tier-2 subagents get Bash by default (Rafe's call, 2026-07-03) —
  // observable via Activity, stoppable in one click. Off reverts to read-only.
  subagent_bash: z.boolean().default(true),
});
export type Config = z.infer<typeof ConfigSchema>;

// ~/.jarvis/env holds KEY=VALUE lines (ANTHROPIC_API_KEY lives here);
// loaded into process.env without overriding an already-set variable.
function loadEnvFile(): void {
  const envPath = join(JARVIS_HOME, "env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key && value !== undefined && !process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

export function loadConfig(): Config {
  mkdirSync(JARVIS_HOME, { recursive: true, mode: 0o700 });
  loadEnvFile();
  const tomlPath = join(JARVIS_HOME, "config.toml");
  const raw = existsSync(tomlPath) ? parseToml(readFileSync(tomlPath, "utf8")) : {};
  return ConfigSchema.parse(raw);
}

// Persist a settings patch. jarvisd is the single writer; the stage panel, the
// HTTP control endpoints, and the settings MCP server all funnel through here.
// Unknown keys already in the file survive; comments don't (smol-toml rewrite).
export function saveConfig(patch: Record<string, unknown>): void {
  const tomlPath = join(JARVIS_HOME, "config.toml");
  const raw = existsSync(tomlPath) ? parseToml(readFileSync(tomlPath, "utf8")) : {};
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  writeFileSync(tomlPath, stringifyToml({ ...raw, ...defined }) + "\n");
}

export function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      `ANTHROPIC_API_KEY is not set. Export it, or put ANTHROPIC_API_KEY=... in ${join(JARVIS_HOME, "env")} (chmod 600).`,
    );
  }
  return key;
}
