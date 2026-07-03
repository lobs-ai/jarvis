import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { WhisperStt, ChatterboxTts } from "@jarvis/voice";
import { SettingsPatch, type SettingsSnapshot } from "@jarvis/protocol";
import { loadConfig, saveConfig } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import { Session } from "./session.js";
import { StageSocket } from "./ws.js";
import { McpManager, riskOf, type McpServerSpec } from "./mcp/manager.js";
import { ConfirmBroker } from "./mcp/confirm.js";
import { BackgroundRunner } from "./brain/tasks.js";
import type { ToolDef } from "./brain/loop.js";
import type { BrainPort } from "./brain/port.js";
import { ApiBrain } from "./brain/api-brain.js";
import { CliBrain } from "./brain/cli-brain.js";

const STAGE_DIST = fileURLToPath(new URL("../../stage/dist", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

// Tools Claude Code may call directly on the subscription path: speech, the
// shell (Rafe's call — Jarvis runs what it needs to run; destructive-action
// asking is a prompt norm), web, reads, and a wiki PROPOSAL. Mutating tools +
// context tools are withheld: jarvisd gates commits and owns bundle assembly
// (design §Security).
const CLI_ALLOWED = [
  "mcp__speech__say",
  "Bash",
  "WebSearch",
  "WebFetch",
  "mcp__wiki__wiki_search",
  "mcp__wiki__wiki_read",
  "mcp__wiki__wiki_propose_edit",
  "mcp__browser__browser_open",
  "mcp__browser__browser_read",
  // Jarvis may adjust its own settings (both route through jarvisd's HTTP
  // control endpoint, so the stage sees every change immediately)
  "mcp__settings__settings_get",
  "mcp__settings__settings_set",
];
const CLI_DISALLOWED = [
  // file editing stays out — Jarvis is not a coding agent; the wiki gate would
  // be meaningless if Edit/Write could touch ~/wiki directly
  "Edit",
  "Write",
  "NotebookEdit",
  "TodoWrite",
  "mcp__terminal__terminal_run", // Claude Code's own Bash is the shell here
  "mcp__wiki__wiki_commit",
  "mcp__wiki__wiki_context",
  "mcp__terminal__terminal_context",
  "mcp__browser__browser_context",
  "mcp__browser__browser_click",
  "mcp__browser__browser_type",
];

function hasClaudeCli(): boolean {
  try {
    return spawnSync("claude", ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".json": "application/json",
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new MemoryStore(cfg.retention_days);
  const sock = new StageSocket();

  const confirm = new ConfirmBroker(
    (confirmId, summary, detail, phrases) =>
      sock.sendConfirmRequest(confirmId, summary, detail, phrases),
    (confirmId, approved) => sock.sendConfirmResolved(confirmId, approved),
  );
  sock.onConfirm = (confirmId, approve) => confirm.resolve(confirmId, approve);

  const mcp = new McpManager();

  // The wiki server resolves its directory per call from ~/.jarvis/config.toml
  // (no env pin), so a settings change moves the wiki without any restart.
  const servers: McpServerSpec[] = [
    { name: "wiki", command: TSX, args: [join(REPO_ROOT, "servers/wiki/src/index.ts")] },
    { name: "terminal", command: TSX, args: [join(REPO_ROOT, "servers/terminal/src/index.ts")] },
    { name: "browser", command: TSX, args: [join(REPO_ROOT, "servers/browser/src/index.ts")] },
    {
      name: "settings",
      command: TSX,
      args: [join(REPO_ROOT, "servers/settings/src/index.ts")],
      env: { JARVIS_PORT: String(cfg.port) },
    },
  ];
  // The speech server exists ONLY for the CLI child: say is how the model
  // speaks there (jarvisd streams its input text; the server just acks).
  // jarvisd's own McpManager and the API brain must never see it.
  const cliServers: McpServerSpec[] = [
    ...servers,
    { name: "speech", command: TSX, args: [join(REPO_ROOT, "servers/speech/src/index.ts")] },
  ];

  // Brain selection: prefer Rafe's Claude Code subscription (CliBrain); fall
  // back to the Anthropic SDK only if the CLI is unavailable or JARVIS_BRAIN=api.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const useCli = process.env.JARVIS_BRAIN !== "api" && hasClaudeCli();

  // Proposal gate (subscription path): Claude may PROPOSE wiki edits but not
  // commit — jarvisd shows the diff, confirms, and commits via its own MCP
  // client, so nothing lands without Rafe's yes even though Claude owns the loop.
  const gateProposal = (name: string, text: string): void => {
    if (!/wiki_propose_edit$/.test(name)) return;
    const m = text.match(/proposal (\w+)/);
    if (!m) return;
    const id = m[1]!;
    void (async () => {
      await session.waitForActiveDrain(); // let the model finish showing the diff
      const ok = await confirm.request(`Commit this wiki edit? (proposal ${id})`, text.slice(0, 800));
      if (!ok) return;
      const res = await mcp.execute("wiki_commit", { proposal_id: id });
      session.announceWhenIdle("Committed to the wiki.", res);
    })();
  };

  let client: Anthropic | null = null;
  let brain: BrainPort;
  if (useCli) {
    brain = new CliBrain({
      model: cfg.model_tier1,
      thinking: cfg.thinking,
      wikiDir: () => cfg.wiki_dir,
      servers: cliServers,
      allowedTools: CLI_ALLOWED,
      disallowedTools: CLI_DISALLOWED,
      onToolCall: () => {},
      onToolResult: gateProposal,
      facts: () => store.readFacts(),
    });
    console.log("brain: Claude Code subscription (CLI) — no API key needed");
  } else {
    if (!apiKey) {
      console.error(
        "No brain available. Either install/login Claude Code (uses your subscription),\n" +
          "or put ANTHROPIC_API_KEY=... in ~/.jarvis/env (chmod 600).",
      );
      process.exit(1);
    }
    client = new Anthropic({ apiKey });
    brain = new ApiBrain(client, cfg.model_tier1, () => store.readFacts());
    console.log("brain: Anthropic API (SDK)");
  }

  const session = new Session(brain, sock, store, null, null);
  sock.bind(session);
  session.attachMcp(mcp, confirm);

  // ── Settings control plane ─────────────────────────────────────
  // jarvisd is the single writer: the stage panel (WS), the settings MCP
  // server (HTTP), and curl all land in applySettings. Wiki moves apply live
  // (the wiki server re-reads config per call); model/thinking are baked into
  // the CLI child, so they restart the conversation — deferred to turn end
  // when Jarvis changes them on itself mid-turn.
  const currentSettings = (): SettingsSnapshot => ({
    wiki_dir: cfg.wiki_dir,
    model_tier1: cfg.model_tier1,
    model_tier2: cfg.model_tier2,
    thinking: cfg.thinking,
  });

  let brainRestartPending = false;
  const restartBrain = (): void => {
    brain.reset?.();
    sock.sendSessionReset();
  };
  session.onIdle = () => {
    if (!brainRestartPending) return;
    brainRestartPending = false;
    restartBrain();
  };

  const applySettings = (raw: unknown): { settings: SettingsSnapshot; note?: string } => {
    const patch = SettingsPatch.parse(raw);
    saveConfig(patch);
    const notes: string[] = [];
    if (patch.wiki_dir && patch.wiki_dir !== cfg.wiki_dir) {
      cfg.wiki_dir = patch.wiki_dir;
      notes.push(`wiki → ${patch.wiki_dir}`);
    }
    if (patch.model_tier2 && patch.model_tier2 !== cfg.model_tier2) {
      cfg.model_tier2 = patch.model_tier2;
      notes.push(`tier-2 → ${patch.model_tier2}`);
    }
    const brainChanged =
      (patch.model_tier1 && patch.model_tier1 !== cfg.model_tier1) ||
      (patch.thinking && patch.thinking !== cfg.thinking);
    if (brainChanged) {
      if (patch.model_tier1) cfg.model_tier1 = patch.model_tier1;
      if (patch.thinking) cfg.thinking = patch.thinking;
      brain.configure?.({ model: cfg.model_tier1, thinking: cfg.thinking });
      if (session.isActive()) {
        brainRestartPending = true;
        notes.push(`${cfg.model_tier1}, thinking ${cfg.thinking} — fresh conversation when this turn ends`);
      } else {
        restartBrain();
        notes.push(`${cfg.model_tier1}, thinking ${cfg.thinking} — fresh conversation`);
      }
    }
    const result = { settings: currentSettings(), note: notes.join(" · ") || undefined };
    sock.sendSettings(result.settings, result.note);
    return result;
  };

  sock.onConnect = () => sock.sendSettings(currentSettings());
  sock.onSettingsGet = () => sock.sendSettings(currentSettings());
  sock.onSettingsSet = (patch) => {
    try {
      applySettings(patch);
    } catch (err) {
      sock.sendWarning(`settings rejected: ${String(err)}`);
    }
  };
  sock.onSessionNew = () => {
    session.resetConversation();
    brainRestartPending = false; // the reset already delivered any pending change
    sock.sendSessionReset();
  };

  // Voice ports: degrade gracefully if a sidecar is down (captions carry the turn).
  const stt = new WhisperStt(cfg.stt_url);
  const tts = new ChatterboxTts(cfg.tts_url, cfg.tts_voice);
  const [sttOk, ttsOk] = await Promise.all([stt.healthy(), tts.healthy()]);
  session.setVoicePorts(sttOk ? stt : null, ttsOk ? tts : null);
  console.log(`voice ports: stt=${sttOk ? "ok" : "DOWN"} tts=${ttsOk ? "ok" : "DOWN"}`);
  if (!ttsOk) {
    // TTS model load takes a while on cold start; re-probe until it comes up.
    const probe = setInterval(() => {
      void tts.healthy().then((ok) => {
        if (ok) {
          session.setVoicePorts(sttOk ? stt : null, tts);
          console.log("voice ports: tts came up");
          clearInterval(probe);
        }
      });
    }, 5000);
  }

  // jarvisd's own MCP connections: used for bundle context (both brains) and
  // jarvisd-gated wiki commits (CLI path). On the API path they also feed the
  // model's tools + tier-2 + built-ins.
  if (client) {
    // ── Anthropic SDK path: jarvisd owns tool execution ──────────────
    const bg = new BackgroundRunner(client, cfg.model_tier2, servers, (report) => {
      const summary =
        report.report.length > 400 ? report.report.slice(0, 400) + "…" : report.report;
      const proposalNote = report.proposals.length
        ? ` I staged ${report.proposals.length} wiki edit(s) for you to review.`
        : "";
      session.announceWhenIdle(`Finished "${report.task.slice(0, 60)}".${proposalNote}`, summary);
    });
    session.setBackgroundDispatch((task) => bg.dispatch(task));

    const BUILTIN_TOOLS: ToolDef[] = [
      {
        name: "dispatch_background",
        description:
          "Hand a long-running task to your background worker (stronger, slower model). Returns immediately; you'll be able to report the result when it finishes. Use for multi-step work like reorganizing wiki pages — NOT for quick answers.",
        input_schema: {
          type: "object",
          properties: { task: { type: "string", description: "self-contained task description" } },
          required: ["task"],
        },
      },
      {
        name: "remember_fact",
        description:
          "Append one line to YOUR OWN operational memory about working with Rafe (preferences, standing instructions, pronunciation fixes like `say: MemCore => mem core`). This is NOT the wiki — never store facts about Rafe's life here.",
        input_schema: {
          type: "object",
          properties: { fact: { type: "string" } },
          required: ["fact"],
        },
      },
    ];

    const refreshTools = (): void => {
      session.setTools([...BUILTIN_TOOLS, ...mcp.tools()], async (name, input) => {
        if (name === "dispatch_background") {
          const id = bg.dispatch(String(input.task ?? ""));
          return `dispatched as ${id}; tell Rafe you'll report back when it's done.`;
        }
        if (name === "remember_fact") {
          session.appendFact(String(input.fact ?? ""));
          return "remembered.";
        }
        const risk = riskOf(name);
        if (risk !== "read") await session.waitForActiveDrain(); // narrate-then-act
        if (risk === "mutate") {
          const summary = `${name}(${JSON.stringify(input).slice(0, 120)})`;
          const ok = await confirm.request(summary, JSON.stringify(input, null, 2));
          if (!ok) return "DENIED: Rafe did not confirm this action. Do not retry it unless he asks.";
        }
        return mcp.execute(name, input);
      });
    };
    mcp.onToolsChanged = refreshTools;
    void mcp.connectAll(servers).then(refreshTools);
    refreshTools();
  } else {
    // ── Subscription path: Claude Code calls MCP directly; jarvisd's own
    // connections are only for bundle context + the gated commit. Tier-2
    // dispatch and model-written facts are API-path features for now.
    void mcp.connectAll(servers);
  }

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Settings control endpoint (localhost-only): GET reads, POST applies a
    // patch. The settings MCP server rides this, so Jarvis's own changes flow
    // through the same single writer as the stage panel.
    if (url === "/settings") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(currentSettings()));
        return;
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          try {
            const result = applySettings(JSON.parse(body || "{}"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
        return;
      }
      res.writeHead(405);
      res.end("GET or POST");
      return;
    }
    // Exhibit ref resolver: <show ref="wiki:PATH"/> → the stage fetches here.
    if (url === "/ref") {
      const uri = new URL(req.url ?? "", "http://x").searchParams.get("uri") ?? "";
      const m = uri.match(/^wiki:(.+)$/);
      if (!m) {
        res.writeHead(404);
        res.end(`unresolvable ref scheme: ${uri}`);
        return;
      }
      void mcp
        .execute("wiki_read", { path: m[1]! })
        .then((text) => {
          if (text.startsWith("tool error") || text.startsWith("tool unavailable") || text.startsWith("no such page")) {
            res.writeHead(404);
            res.end(text.slice(0, 500));
            return;
          }
          // strip the "# path (base-hash …)" header wiki_read prepends
          const body = text.replace(/^# \S+ \(base-hash \w+\)\n\n/, "");
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(body);
        })
        .catch((err) => {
          res.writeHead(500);
          res.end(String(err));
        });
      return;
    }
    // Static stage. COOP/COEP: the Silero VAD worker needs cross-origin isolation.
    const rel = url === "/" ? "/index.html" : url;
    const path = normalize(join(STAGE_DIST, rel));
    if (!path.startsWith(STAGE_DIST) || !existsSync(path)) {
      res.writeHead(404);
      res.end("not found (did you build the stage? bin/jarvis start --build)");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(path)] ?? "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cache-control": "no-cache",
    });
    res.end(readFileSync(path));
  });

  sock.attach(server);
  server.listen(cfg.port, "127.0.0.1", () => {
    console.log(`jarvisd listening on http://127.0.0.1:${cfg.port} (stage + /ws)`);
    console.log(`tier-1 model: ${cfg.model_tier1}`);
  });
}

void main();
