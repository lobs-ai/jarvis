// jarvis workspace — the lab-activity stream. workspace_context returns a
// git roster of recently active repos under Rafe's workspace roots (default
// ~/other/lobs): branch, dirty count, last commit, recency. This is the
// zero-integration answer to "what was he in the middle of?" — the panes/tabs
// roster shows what's on screen right now; this shows what's been worked on
// lately even if no window is open on it.
//
// The bundle assembler races context tools against a ~300ms timeout, so this
// tool must answer instantly: it serves a CACHED snapshot, refreshed in the
// background every REFRESH_MS. Scanning ~60 candidate dirs with a couple of
// git calls each is fine on a timer, fatal inline.
//
// Roots come from ~/.jarvis/config.toml `workspace_dirs`, read per refresh
// (the wiki server's live-config pattern) so a change lands without a restart.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const JARVIS_HOME = join(homedir(), ".jarvis");
const DEFAULT_ROOTS = [join(homedir(), "other", "lobs")];

const REFRESH_MS = 5 * 60_000;
const ACTIVE_WINDOW_DAYS = 14; // repos idle longer than this drop off the roster
const ROSTER_CAP = 12;
const GIT_TIMEOUT_MS = 4000;
const SCAN_CAP = 120; // candidate dirs per root — a runaway workspace can't stall refresh

function roots(): string[] {
  try {
    const raw = parseToml(readFileSync(join(JARVIS_HOME, "config.toml"), "utf8"));
    const dirs = (raw as Record<string, unknown>).workspace_dirs;
    if (Array.isArray(dirs) && dirs.every((d) => typeof d === "string") && dirs.length > 0)
      return dirs.map((d) => d.replace(/^~(?=\/|$)/, homedir()));
  } catch {
    /* no config yet, or no key — defaults */
  }
  return DEFAULT_ROOTS;
}

function git(repo: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repo, ...args],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

interface RepoState {
  name: string;
  branch: string;
  dirty: number;
  lastSubject: string;
  activeAt: number; // ms epoch — max(last commit, index/HEAD mtime)
}

function mtimeOr0(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function readRepo(dir: string, name: string): Promise<RepoState | null> {
  const [log, status, branch] = await Promise.all([
    git(dir, ["log", "-1", "--format=%ct\t%s"]),
    // --no-optional-locks: plain `git status` refreshes the index as a side
    // effect, which would bump .git/index mtime on every scan — the roster
    // would drag every repo toward "0m ago" and nothing would ever age off
    git(dir, ["--no-optional-locks", "status", "--porcelain"]),
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  if (log === null && status === null) return null; // not readable as a repo
  const [ctRaw, subject = ""] = (log ?? "").trim().split("\t");
  const commitMs = Number(ctRaw) * 1000 || 0;
  // uncommitted work bumps recency too: the index moves on add/status refresh,
  // HEAD on branch switches — a repo he's editing but hasn't committed still counts
  const activeAt = Math.max(
    commitMs,
    mtimeOr0(join(dir, ".git", "index")),
    mtimeOr0(join(dir, ".git", "HEAD")),
  );
  const dirty = (status ?? "").split("\n").filter(Boolean).length;
  return {
    name,
    branch: (branch ?? "").trim() || "?",
    dirty,
    lastSubject: subject.slice(0, 60),
    activeAt,
  };
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 60) return `${Math.max(min, 0)}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

let snapshot = "workspace scan hasn't completed yet";
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 3600 * 1000;
    const found: RepoState[] = [];
    const scannedRoots: string[] = [];
    for (const root of roots()) {
      if (!existsSync(root)) continue;
      scannedRoots.push(root);
      const entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .slice(0, SCAN_CAP);
      // cheap pre-filter before any git call: .git must exist and have moved
      // within the window (index/HEAD mtime); spares ~50 idle repos 3 execs each
      const candidates = entries.filter((e) => {
        const g = join(root, e.name, ".git");
        if (!existsSync(g)) return false;
        return (
          mtimeOr0(join(g, "index")) > cutoff ||
          mtimeOr0(join(g, "HEAD")) > cutoff ||
          mtimeOr0(g) > cutoff
        );
      });
      const states = await Promise.all(
        candidates.map((e) => readRepo(join(root, e.name), e.name)),
      );
      for (const s of states) {
        if (s && s.activeAt > cutoff) found.push(s);
      }
    }
    found.sort((a, b) => b.activeAt - a.activeAt);
    const shown = found.slice(0, ROSTER_CAP);
    const lines = shown.map((r) => {
      const dirty = r.dirty > 0 ? `${r.dirty} dirty` : "clean";
      const last = r.lastSubject ? ` · "${r.lastSubject}"` : "";
      return `${r.name}  ${r.branch} · ${dirty} · ${ago(r.activeAt)}${last}`;
    });
    const extra = found.length > shown.length ? `\n… +${found.length - shown.length} more` : "";
    snapshot =
      lines.length === 0
        ? `no repos active in the last ${ACTIVE_WINDOW_DAYS}d under ${scannedRoots.join(", ")}`
        : `recently active repos (${scannedRoots.join(", ")}), newest first:\n${lines.join("\n")}${extra}\n` +
          `(drill in via the shell: git -C <root>/<repo> log/status/diff)`;
  } catch (err) {
    snapshot = `workspace scan failed: ${String(err)}`;
  } finally {
    refreshing = false;
  }
}

void refresh();
const timer = setInterval(() => void refresh(), REFRESH_MS);
timer.unref?.();

const server = new McpServer({ name: "jarvis-workspace", version: "0.1.0" });

server.tool(
  "workspace_context",
  "Recently active git repos in Rafe's workspace (branch, dirty files, last commit, " +
    "recency) — cached, for the turn's context bundle.",
  {},
  async () => ({ content: [{ type: "text", text: snapshot }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
