// jarvis watch — the follow-through ledger. Standing items Jarvis is keeping an
// eye on ("remind me", "keep an eye on that migration", "make sure CI goes
// green"), durable across conversations and daemon restarts.
//
// This is what makes follow-through real rather than vibes: watch_context rides
// every turn's bundle (heartbeats included), so open items are always in view;
// when a beat's evidence shows one is done or moot, the model closes it with
// watch_done instead of nagging about finished work.
//
// Store: ~/.jarvis/watch.json, read and rewritten PER CALL with no in-memory
// state — jarvisd and the CLI child each spawn their own instance of this
// server, and per-call disk reads are what keep them coherent (the same lesson
// as the on-disk wiki proposals). Single user, low write rate; last write wins.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const JARVIS_HOME = join(homedir(), ".jarvis");
const STORE_PATH = join(JARVIS_HOME, "watch.json");

const OPEN_CAP = 30; // a watch list longer than this is a todo app, not awareness
const DONE_RETENTION_DAYS = 7;

const Item = z.object({
  id: z.string(),
  text: z.string(),
  // optional address the item is about: a pane (work:2.1), a repo (jarvis), a URL, a PR
  target: z.string().optional(),
  created: z.string(), // ISO
  status: z.enum(["open", "done"]),
  note: z.string().optional(), // how it resolved
  resolved: z.string().optional(), // ISO
});
type Item = z.infer<typeof Item>;

function load(): Item[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    return z.array(Item).parse(raw);
  } catch {
    return []; // a corrupt store must never wedge the bundle
  }
}

function save(items: Item[]): void {
  mkdirSync(JARVIS_HOME, { recursive: true, mode: 0o700 });
  // prune resolved items past retention on every write
  const cutoff = Date.now() - DONE_RETENTION_DAYS * 24 * 3600 * 1000;
  const kept = items.filter(
    (i) => i.status === "open" || !i.resolved || Date.parse(i.resolved) > cutoff,
  );
  const tmp = STORE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(kept, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, STORE_PATH);
}

function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(min, 0)}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function fmt(i: Item): string {
  const target = i.target ? ` (${i.target})` : "";
  if (i.status === "done") {
    const note = i.note ? ` — ${i.note}` : "";
    return `[${i.id}] done ${i.resolved ? age(i.resolved) : "?"} ago: ${i.text}${target}${note}`;
  }
  return `[${i.id}, open ${age(i.created)}] ${i.text}${target}`;
}

const server = new McpServer({ name: "jarvis-watch", version: "0.1.0" });

server.tool(
  "watch_add",
  "Add a standing watch item — something to keep an eye on and follow through " +
    "across conversations (\"keep an eye on\", \"remind me\", \"make sure X\", or a " +
    "check you promised to do later). Write it short and VERIFIABLE — a future glance " +
    "at the workspace should be able to tell whether it's done. Open items ride every " +
    "turn's context bundle until closed with watch_done.",
  {
    text: z.string().describe("the item, short and checkable, e.g. \"agentd tests back to green after the socket refactor\""),
    target: z
      .string()
      .optional()
      .describe("optional address it's about: a repo name, tmux pane (work:2.1), URL, or PR"),
  },
  async ({ text, target }) => {
    const items = load();
    const open = items.filter((i) => i.status === "open");
    if (open.length >= OPEN_CAP) {
      return {
        content: [
          {
            type: "text",
            text: `refused: ${open.length} items already open — close some with watch_done before adding more`,
          },
        ],
        isError: true,
      };
    }
    const item: Item = {
      id: `w${randomBytes(2).toString("hex")}`,
      text: text.trim(),
      target: target?.trim() || undefined,
      created: new Date().toISOString(),
      status: "open",
    };
    items.push(item);
    save(items);
    return { content: [{ type: "text", text: `watching [${item.id}]: ${item.text}` }] };
  },
);

server.tool(
  "watch_done",
  "Close a watch item: it was observed done, handled, or is moot. Prefer closing " +
    "quietly over announcing it — mention it aloud only if Rafe would genuinely want " +
    "the heads-up.",
  {
    id: z.string().describe("the item id, e.g. w3f2a"),
    note: z.string().optional().describe("one short line on how it resolved"),
  },
  async ({ id, note }) => {
    const items = load();
    const item = items.find((i) => i.id === id);
    if (!item) return { content: [{ type: "text", text: `no such watch item: ${id}` }], isError: true };
    if (item.status === "done")
      return { content: [{ type: "text", text: `[${id}] was already closed` }] };
    item.status = "done";
    item.resolved = new Date().toISOString();
    if (note?.trim()) item.note = note.trim();
    save(items);
    return { content: [{ type: "text", text: `closed [${id}]: ${item.text}` }] };
  },
);

server.tool(
  "watch_list",
  "List all watch items — open ones plus what resolved in the last week.",
  {},
  async () => {
    const items = load();
    const open = items.filter((i) => i.status === "open");
    const done = items.filter((i) => i.status === "done");
    const parts: string[] = [];
    parts.push(open.length ? `open (${open.length}):\n${open.map(fmt).join("\n")}` : "no open watch items");
    if (done.length) parts.push(`recently closed:\n${done.map(fmt).join("\n")}`);
    return { content: [{ type: "text", text: parts.join("\n\n") }] };
  },
);

// Rides every turn's bundle via McpManager.collectContext() *_context discovery.
server.tool(
  "watch_context",
  "Open watch items (standing follow-through), for the turn's context bundle.",
  {},
  async () => {
    const open = load().filter((i) => i.status === "open");
    if (open.length === 0)
      return { content: [{ type: "text", text: "no open watch items" }] };
    return {
      content: [
        { type: "text", text: `standing watch items (${open.length} open):\n${open.map(fmt).join("\n")}` },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
