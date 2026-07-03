import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, requireApiKey } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import { Session } from "./session.js";
import { StageSocket } from "./ws.js";

const STAGE_DIST = fileURLToPath(new URL("../../stage/dist", import.meta.url));

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

function main(): void {
  const cfg = loadConfig();
  const apiKey = requireApiKey();
  const client = new Anthropic({ apiKey });
  const store = new MemoryStore(cfg.retention_days);
  const sock = new StageSocket();
  const session = new Session(cfg, client, sock, store, null, null);
  sock.bind(session);

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

main();
