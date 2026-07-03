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
  // extended-thinking budget for tier-1 (off measured 9s→2s ttft on opus)
  thinking: z.enum(["off", "low", "medium", "high"]).default("off"),
  stt_url: z.string().default("http://127.0.0.1:7423"),
  tts_url: z.string().default("http://127.0.0.1:7422"),
  tts_voice: z.string().default("default"),
  retention_days: z.number().int().default(30),
  wiki_dir: z.string().default(join(homedir(), "wiki")),
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
