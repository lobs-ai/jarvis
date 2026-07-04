import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { WhisperStt, ChatterboxTts } from "@jarvis/voice";
import { SettingsPatch, type ActivityDraft, type SettingsSnapshot } from "@jarvis/protocol";
import { loadConfig, saveConfig, JARVIS_HOME } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import { Session } from "./session.js";
import { StageSocket } from "./ws.js";
import { McpManager, riskOf, type McpServerSpec } from "./mcp/manager.js";
import { ConfirmBroker } from "./mcp/confirm.js";
import { BackgroundRunner, type BackgroundReport } from "./brain/tasks.js";
import { SubagentManager, type SubagentReport } from "./subagents/manager.js";
import { buildAmbientDraftTask, distillTranscript, hasSubstance } from "./brain/ambient-draft.js";
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
  "mcp__wiki__wiki_list",
  "mcp__wiki__wiki_propose_edit",
  "mcp__browser__browser_open",
  "mcp__browser__browser_read",
  // Jarvis may adjust its own settings (both route through jarvisd's HTTP
  // control endpoint, so the stage sees every change immediately)
  "mcp__settings__settings_get",
  "mcp__settings__settings_set",
  // interactive tier-2 subagents (§II.5) — all thin proxies to /subagents;
  // dispatch_background is kept as an alias of subagent_start
  "mcp__tasks__subagent_start",
  "mcp__tasks__subagent_send",
  "mcp__tasks__subagent_status",
  "mcp__tasks__subagent_result",
  "mcp__tasks__subagent_stop",
  "mcp__tasks__dispatch_background",
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
  const idleSessionEndMs = cfg.idle_session_end_min * 60_000;
  const store = new MemoryStore(cfg.retention_days, idleSessionEndMs);
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
    {
      name: "tasks",
      command: TSX,
      args: [join(REPO_ROOT, "servers/tasks/src/index.ts")],
      env: { JARVIS_PORT: String(cfg.port) },
    },
  ];

  // Brain selection: prefer Rafe's Claude Code subscription (CliBrain); fall
  // back to the Anthropic SDK only if the CLI is unavailable or JARVIS_BRAIN=api.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const cliAvailable = hasClaudeCli();
  const useCli = process.env.JARVIS_BRAIN !== "api" && cliAvailable;

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

  brain.warm?.(); // spawn the CLI child now — MCP servers connect before turn #1

  const session = new Session(brain, sock, store, null, null);
  sock.bind(session);
  session.attachMcp(mcp, confirm);
  // the gate applies only while enabled — the word survives toggling off
  session.getWakeWord = () => (cfg.wake_enabled ? cfg.wake_word : "");

  // Single appender for activity that originates OUTSIDE the session (subagent
  // fan-out): stamp via the store, broadcast the exact on-disk record.
  const emitActivity = (draft: ActivityDraft): void => {
    sock.sendActivity(store.append(draft));
  };

  // ── Tier-2 background pipeline ─────────────────────────────────
  // Reports announce when the room goes idle; staged wiki edits then walk
  // through the same confirm→gated-commit flow as tier-1 proposals, one diff
  // at a time. Proposals persist on disk (~/.jarvis/proposals), so a worker
  // that already exited can still be committed from jarvisd's wiki server.
  const reviewProposals = async (proposals: string[]): Promise<void> => {
    for (const id of proposals) {
      let detail = `(proposal ${id})`;
      try {
        const raw = JSON.parse(
          readFileSync(join(JARVIS_HOME, "proposals", `${id}.json`), "utf8"),
        ) as { path?: string; diff?: string };
        detail = `${raw.path ?? ""}\n\n${raw.diff ?? ""}`.trim().slice(0, 4000);
      } catch {
        /* fall back to the bare id — the report described it */
      }
      await session.waitForActiveDrain();
      const ok = await confirm.request(`Commit background wiki edit? (proposal ${id})`, detail);
      if (!ok) continue;
      const res = await mcp.execute("wiki_commit", { proposal_id: id });
      session.announceWhenIdle("Committed a background wiki edit.", res);
    }
  };

  const AMBIENT_LABEL = "ambient wiki draft";
  const onSubagentReport = (r: SubagentReport): void => {
    // An ambient draft that found nothing stays silent — proposals are the only
    // thing worth interrupting the room for, and even those wait for idle.
    if (r.label === AMBIENT_LABEL && r.proposals.length === 0) return;
    const summary = r.report.length > 400 ? r.report.slice(0, 400) + "…" : r.report;
    const proposalNote = r.proposals.length
      ? ` I staged ${r.proposals.length} wiki edit(s) for you to review.`
      : "";
    const who = r.label !== r.subId ? `"${r.label}" (${r.subId})` : r.subId;
    session.announceWhenIdle(`${who} finished.${proposalNote}`, summary);
    // notification, never interruption: the tier-1 model learns on its NEXT turn
    session.noteForNextTurn(`background subagent ${r.subId} finished: ${summary.slice(0, 300)}`);
    if (r.proposals.length) void reviewProposals(r.proposals);
  };

  // Interactive subagents need the claude CLI (they ARE persistent claude
  // children); the SDK BackgroundRunner remains only as the API-path fallback.
  let subagents: SubagentManager | null = null;
  let dispatchBackground: ((task: string, label?: string) => string) | null = null;
  if (cliAvailable) {
    subagents = new SubagentManager({
      model: () => cfg.model_tier2,
      thinking: () => cfg.thinking_tier2,
      bashAllowed: () => cfg.subagent_bash && process.env.SUBAGENT_BASH !== "off",
      servers: cliServers.filter((s) => s.name === "wiki"),
      emit: emitActivity,
      onReport: onSubagentReport,
    });
    dispatchBackground = (task, label) =>
      subagents!.start(task, label, {
        session: session.sessionId,
        parentTurn: session.activeTurnId,
      });
    sock.onSubagentSend = (id, message) => {
      try {
        subagents!.send(id, message);
      } catch (err) {
        sock.sendWarning(String(err));
      }
    };
    sock.onSubagentStop = (id) => {
      try {
        subagents!.stop(id);
      } catch (err) {
        sock.sendWarning(String(err));
      }
    };
  }

  // ── Session lifecycle (Layer 1 + 3) ───────────────────────────
  session.onSessionEnd = (closedId) => {
    brainRestartPending = false; // the reset already delivered any pending change
    if (!cfg.ambient_drafting || !subagents) return;
    // Don't stack ambient drafts: if a prior one is still generating, skip this
    // one. Ambient drafting is best-effort (proposing nothing is fine), and two
    // background Opus children at once starve the next foreground voice turn.
    if (subagents.hasWorkingLabel(AMBIENT_LABEL)) {
      console.log(`[ambient] draft skipped for ${closedId}: a prior draft is still working`);
      return;
    }
    const events = store.readSession(closedId);
    if (!hasSubstance(events)) return;
    try {
      subagents.start(buildAmbientDraftTask(distillTranscript(events)), AMBIENT_LABEL, {
        session: closedId,
      });
      console.log(`[ambient] draft task dispatched over session ${closedId}`);
    } catch (err) {
      console.error(`[ambient] draft dispatch skipped: ${String(err)}`);
    }
  };
  // Idle backstop: defers while THIS session's subagents are still working (§7).
  session.startIdleBackstop(idleSessionEndMs, () => subagents?.hasBusy(session.sessionId) ?? false);

  // ── Settings control plane ─────────────────────────────────────
  // jarvisd is the single writer: the stage panel (WS), the settings MCP
  // server (HTTP), and curl all land in applySettings. The wiki server reads
  // config per call, but wiki_dir / model / thinking are all baked into the
  // CLI child (the prompt embeds a wiki snapshot), so any of them restarts
  // the conversation — deferred to turn end when changed mid-turn.
  const currentSettings = (): SettingsSnapshot => ({
    wiki_dir: cfg.wiki_dir,
    model_tier1: cfg.model_tier1,
    model_tier2: cfg.model_tier2,
    thinking: cfg.thinking,
    thinking_tier2: cfg.thinking_tier2,
    wake_word: cfg.wake_word,
    wake_enabled: cfg.wake_enabled,
  });

  let brainRestartPending = false;
  // A brain restart is a session end (Layer 1): the durable transcript closes
  // and rotates with the conversation, so replay never resurrects a cleared room.
  const restartBrain = (): void => session.endSession("button");
  session.onIdle = () => {
    if (!brainRestartPending) return;
    brainRestartPending = false;
    restartBrain();
  };

  const applySettings = (raw: unknown): { settings: SettingsSnapshot; note?: string } => {
    const patch = SettingsPatch.parse(raw);
    saveConfig(patch);
    const notes: string[] = [];
    let brainChanged = false;
    if (patch.wiki_dir && patch.wiki_dir !== cfg.wiki_dir) {
      cfg.wiki_dir = patch.wiki_dir;
      notes.push(`wiki → ${patch.wiki_dir}`);
      brainChanged = true; // the prompt's baked wiki snapshot must re-bake
    }
    if (patch.model_tier2 && patch.model_tier2 !== cfg.model_tier2) {
      cfg.model_tier2 = patch.model_tier2;
      notes.push(`tier-2 → ${patch.model_tier2}`);
    }
    // tier-2 knobs bind the NEXT subagent_start; running subagents keep their
    // spawn-time model until they close (§II.8)
    if (patch.thinking_tier2 && patch.thinking_tier2 !== cfg.thinking_tier2) {
      cfg.thinking_tier2 = patch.thinking_tier2;
      notes.push(`tier-2 thinking → ${patch.thinking_tier2}`);
    }
    if (patch.wake_word !== undefined && patch.wake_word !== cfg.wake_word) {
      cfg.wake_word = patch.wake_word;
      notes.push(patch.wake_word ? `wake word → "${patch.wake_word}"` : "wake word cleared");
    }
    if (patch.wake_enabled !== undefined && patch.wake_enabled !== cfg.wake_enabled) {
      cfg.wake_enabled = patch.wake_enabled;
      notes.push(
        patch.wake_enabled ? `wake word on — say "${cfg.wake_word}…"` : "wake word off — always listening",
      );
    }
    if (
      (patch.model_tier1 && patch.model_tier1 !== cfg.model_tier1) ||
      (patch.thinking && patch.thinking !== cfg.thinking)
    ) {
      if (patch.model_tier1) cfg.model_tier1 = patch.model_tier1;
      if (patch.thinking) cfg.thinking = patch.thinking;
      brain.configure?.({ model: cfg.model_tier1, thinking: cfg.thinking });
      notes.push(`${cfg.model_tier1}, thinking ${cfg.thinking}`);
      brainChanged = true;
    }
    if (brainChanged) {
      if (session.isActive()) {
        brainRestartPending = true;
        notes.push("fresh conversation when this turn ends");
      } else {
        restartBrain();
        notes.push("fresh conversation");
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
  // The button, the spoken phrase, and the idle backstop all route through one
  // endSession(), so ambient drafts fire exactly once however a session ends.
  sock.onSessionNew = () => session.endSession("button");

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
    const onBackgroundDone = (report: BackgroundReport): void =>
      onSubagentReport({
        subId: report.taskId,
        label: report.taskId,
        instruction: report.task,
        report: report.report,
        proposals: report.proposals,
      });
    const bg = new BackgroundRunner(client, cfg.model_tier2, servers, onBackgroundDone);
    if (!dispatchBackground) dispatchBackground = (task) => bg.dispatch(task);

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
          const id = dispatchBackground!(String(input.task ?? ""));
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
    // connections are only for bundle context + the gated commit. Tier-2 rides
    // the SubagentManager (persistent children) wired above.
    void mcp.connectAll(servers);
  }

  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0]!;
    const text = (status: number, body: string): void => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    };
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = (cb: (body: string) => void): void => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => cb(body));
    };

    if (url === "/healthz") {
      json(200, { ok: true });
      return;
    }
    // Settings control endpoint (localhost-only): GET reads, POST applies a
    // patch. The settings MCP server rides this, so Jarvis's own changes flow
    // through the same single writer as the stage panel.
    if (url === "/settings") {
      if (req.method === "GET") {
        json(200, currentSettings());
        return;
      }
      if (req.method === "POST") {
        readBody((body) => {
          try {
            json(200, applySettings(JSON.parse(body || "{}")));
          } catch (err) {
            json(400, { error: String(err) });
          }
        });
        return;
      }
      text(405, "GET or POST");
      return;
    }
    // ── Interactive subagents control endpoint (§II.5). The tasks MCP server
    // and the stage's activity panel both ride this; jarvisd stays the single
    // owner of the pool. /tasks below remains an alias of "start".
    const subMatch = url.match(/^\/subagents(?:\/([\w-]+)(?:\/(\w+))?)?$/);
    if (subMatch) {
      const [, id, verb] = subMatch;
      if (!subagents) {
        text(503, "subagents unavailable: the claude CLI is not installed");
        return;
      }
      try {
        if (!id) {
          if (req.method === "GET") {
            text(200, subagents.status());
            return;
          }
          if (req.method === "POST") {
            readBody((body) => {
              try {
                const parsed = JSON.parse(body || "{}") as { task?: unknown; label?: unknown };
                const task = String(parsed.task ?? "").trim();
                if (!task) throw new Error("missing task");
                const label = parsed.label ? String(parsed.label) : undefined;
                const subId = subagents!.start(task, label, {
                  session: session.sessionId,
                  parentTurn: session.activeTurnId,
                });
                text(
                  200,
                  `started ${subId} (${cfg.model_tier2}, thinking ${cfg.thinking_tier2}) — it runs in the ` +
                    `background; message it with subagent_send, check subagent_status, and the report ` +
                    `will arrive in the conversation when it finishes. Tell Rafe it's running.`,
                );
              } catch (err) {
                text(400, String(err instanceof Error ? err.message : err));
              }
            });
            return;
          }
          text(405, "GET or POST");
          return;
        }
        if (!verb && req.method === "GET") {
          text(200, subagents.status(id));
          return;
        }
        if (verb === "result" && req.method === "GET") {
          text(200, subagents.result(id));
          return;
        }
        if (verb === "send" && req.method === "POST") {
          readBody((body) => {
            try {
              const message = String((JSON.parse(body || "{}") as { message?: unknown }).message ?? "").trim();
              if (!message) throw new Error("missing message");
              text(200, subagents!.send(id, message));
            } catch (err) {
              text(400, String(err instanceof Error ? err.message : err));
            }
          });
          return;
        }
        if (verb === "stop" && req.method === "POST") {
          text(200, subagents.stop(id));
          return;
        }
        text(404, "unknown subagent verb");
      } catch (err) {
        text(400, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    // Background dispatch (kept as an alias of subagent start so existing
    // prompt text and the dispatch_background tool keep working).
    if (url === "/tasks" && req.method === "POST") {
      readBody((body) => {
        try {
          const task = String((JSON.parse(body || "{}") as { task?: unknown }).task ?? "").trim();
          if (!task) throw new Error("missing task");
          if (!dispatchBackground) throw new Error("no background worker available");
          const id = dispatchBackground(task);
          text(
            200,
            `dispatched as ${id} (${cfg.model_tier2}, thinking ${cfg.thinking_tier2}) — ` +
              `the report will arrive in the conversation when it finishes; tell Rafe it's running.`,
          );
        } catch (err) {
          text(400, String(err instanceof Error ? err.message : err));
        }
      });
      return;
    }
    // ── Activity read endpoints (§II.9): the stage's session picker.
    if (url === "/sessions") {
      json(200, store.listSessions());
      return;
    }
    if (url === "/activity") {
      const params = new URL(req.url ?? "", "http://x").searchParams;
      const id = params.get("session") ?? store.sessionId;
      const limit = Math.min(Number(params.get("limit")) || 1000, 5000);
      json(200, store.readSession(id).slice(-limit));
      return;
    }
    // Health for the stage's status strip: live sidecar probes, cheap enough
    // for a 10s poll from a handful of tabs.
    if (url === "/status") {
      void Promise.all([stt.healthy(), tts.healthy()]).then(([sttUp, ttsUp]) => {
        json(200, {
          stt: sttUp,
          tts: ttsUp,
          brain: brain.kind,
          active: session.isActive(),
          uptime_s: Math.round(process.uptime()),
        });
      });
      return;
    }
    // Wiki browser endpoints (stage's wiki tab): thin text proxies over the
    // wiki MCP server, which resolves wiki_dir live from config.
    if (url === "/wiki/pages") {
      void mcp.execute("wiki_list", {}).then(
        (t) => text(200, t),
        (err) => text(500, String(err)),
      );
      return;
    }
    if (url === "/wiki/search") {
      const q = new URL(req.url ?? "", "http://x").searchParams.get("q") ?? "";
      if (!q.trim()) {
        text(400, "missing q");
        return;
      }
      void mcp.execute("wiki_search", { query: q }).then(
        (t) => text(200, t),
        (err) => text(500, String(err)),
      );
      return;
    }
    // Exhibit ref resolver: <show ref="wiki:PATH"/> / <show ref="file:PATH"/> →
    // the stage fetches here.
    if (url === "/ref") {
      const uri = new URL(req.url ?? "", "http://x").searchParams.get("uri") ?? "";
      // file: a repo-relative path (Jarvis's own source/docs), sandboxed to the
      // repo root. The wiki lives elsewhere and stays behind wiki: — a file: ref
      // can never climb into it (or anywhere outside the repo).
      const fileMatch = uri.match(/^file:(.+)$/);
      if (fileMatch) {
        const path = normalize(join(REPO_ROOT, fileMatch[1]!));
        if (!path.startsWith(REPO_ROOT) || !existsSync(path)) {
          text(404, `no such repo file: ${fileMatch[1]!}`);
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(readFileSync(path));
        return;
      }
      const m = uri.match(/^wiki:(.+)$/);
      if (!m) {
        text(404, `unresolvable ref scheme: ${uri}`);
        return;
      }
      void mcp
        .execute("wiki_read", { path: m[1]! })
        .then((t) => {
          if (t.startsWith("tool error") || t.startsWith("tool unavailable") || t.startsWith("no such page")) {
            text(404, t.slice(0, 500));
            return;
          }
          // strip the "# path (base-hash …)" header wiki_read prepends (paths
          // may contain spaces) and YAML frontmatter — neither is content
          const body = t
            .replace(/^# .+? \(base-hash \w+\)\n\n/, "")
            .replace(/^---\n[\s\S]*?\n---\n+/, "");
          text(200, body);
        })
        .catch((err) => text(500, String(err)));
      return;
    }
    // Static stage. COOP/COEP: the Silero VAD worker needs cross-origin isolation.
    const rel = url === "/" ? "/index.html" : url;
    const path = normalize(join(STAGE_DIST, rel));
    if (!path.startsWith(STAGE_DIST) || !existsSync(path)) {
      text(404, "not found (did you build the stage? bin/jarvis start --build)");
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
    console.log(`tier-1 model: ${cfg.model_tier1} · session ${store.sessionId}`);
  });
}

void main();
