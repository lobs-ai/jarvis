import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { WhisperStt, ChatterboxTts } from "@jarvis/voice";
import { loadConfig, requireApiKey } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import { Session } from "./session.js";
import { StageSocket } from "./ws.js";
import { McpManager, riskOf, type McpServerSpec } from "./mcp/manager.js";
import { ConfirmBroker } from "./mcp/confirm.js";

const STAGE_DIST = fileURLToPath(new URL("../../stage/dist", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

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
  const apiKey = requireApiKey();
  const client = new Anthropic({ apiKey });
  const store = new MemoryStore(cfg.retention_days);
  const sock = new StageSocket();
  const session = new Session(cfg, client, sock, store, null, null);
  sock.bind(session);

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

  // MCP: integrations are servers; the stage markup needs none of this (M0),
  // but tools, bundle context, and confirmations all flow through here.
  const confirm = new ConfirmBroker(
    (confirmId, summary, detail, phrases) =>
      sock.sendConfirmRequest(confirmId, summary, detail, phrases),
    (confirmId, approved) => sock.sendConfirmResolved(confirmId, approved),
  );
  sock.onConfirm = (confirmId, approve) => confirm.resolve(confirmId, approve);

  const mcp = new McpManager();
  session.attachMcp(mcp, confirm);

  const refreshTools = (): void => {
    session.setTools(mcp.tools(), async (name, input) => {
      // mutate-class actions require positive confirmation (design §Security)
      if (riskOf(name) === "mutate") {
        const summary = `${name}(${JSON.stringify(input).slice(0, 120)})`;
        const ok = await confirm.request(summary, JSON.stringify(input, null, 2));
        if (!ok) return "DENIED: Rafe did not confirm this action. Do not retry it unless he asks.";
      }
      return mcp.execute(name, input);
    });
  };
  mcp.onToolsChanged = refreshTools;

  const servers: McpServerSpec[] = [
    {
      name: "wiki",
      command: TSX,
      args: [join(REPO_ROOT, "servers/wiki/src/index.ts")],
      env: { JARVIS_WIKI_DIR: cfg.wiki_dir },
    },
  ];
  void mcp.connectAll(servers).then(refreshTools);

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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
