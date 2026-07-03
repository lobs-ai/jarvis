// jarvis wiki MCP server — the single writer for all Jarvis-originated edits.
// propose/commit deliberately split: propose returns a diff + base content
// hashes; commit revalidates them and refuses (re-proposing) if the page moved.
// wiki_commit is mutate-class: jarvisd gates it behind explicit confirmation.

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// The wiki location is a live setting: resolved on every call so a
// settings_set wiki_dir applies without restarting this server or the brain.
// JARVIS_WIKI_DIR pins it (tests); otherwise ~/.jarvis/config.toml rules.
const CONFIG_PATH = join(homedir(), ".jarvis", "config.toml");

function wikiDir(): string {
  if (process.env.JARVIS_WIKI_DIR) return process.env.JARVIS_WIKI_DIR;
  try {
    // one string key out of a small toml — a parser dependency isn't worth it
    const m = readFileSync(CONFIG_PATH, "utf8").match(/^\s*wiki_dir\s*=\s*"(.+)"\s*$/m);
    if (m) return JSON.parse(`"${m[1]!}"`) as string; // unescape toml basic string
  } catch {
    /* no config yet — fall through to the default */
  }
  return join(homedir(), "wiki");
}

interface Proposal {
  path: string; // repo-relative, e.g. "projects/jarvis.md"
  baseHash: string; // sha256 of the file at propose time ("" = new file)
  newContent: string;
  diff: string;
  message: string;
}
const proposals = new Map<string, Proposal>();

function abs(relPath: string): string {
  const root = wikiDir();
  const p = normalize(join(root, relPath));
  if (!p.startsWith(root)) throw new Error("path escapes the wiki");
  return p;
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function listPages(): string[] {
  const root = wikiDir();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md")) out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

function unifiedDiff(path: string, oldText: string, newText: string): string {
  // git handles the diffing; --no-index compares arbitrary blobs. Temp files
  // live in the OS tmpdir — the wiki dir may be a subdir of a repo (no .git).
  const tmpOld = join(tmpdir(), `jarvis-wiki-old-${randomUUID()}`);
  const tmpNew = join(tmpdir(), `jarvis-wiki-new-${randomUUID()}`);
  writeFileSync(tmpOld, oldText);
  writeFileSync(tmpNew, newText);
  try {
    execFileSync("git", ["diff", "--no-index", "--", tmpOld, tmpNew]);
    return `(no changes to ${path})`;
  } catch (err) {
    const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? "";
    return stdout
      .split("\n")
      .filter((l) => !l.startsWith("diff --git") && !l.startsWith("index "))
      .map((l) =>
        l.startsWith("---") ? `--- a/${path}` : l.startsWith("+++") ? `+++ b/${path}` : l,
      )
      .join("\n");
  } finally {
    for (const t of [tmpOld, tmpNew]) {
      try {
        rmSync(t, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function lintLinks(content: string): string[] {
  const pages = new Set(listPages().map((p) => p.replace(/\.md$/, "")));
  const dangling: string[] = [];
  for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1]!.split("|")[0]!.trim();
    if (!pages.has(target) && !pages.has(`${target}/index`)) dangling.push(target);
  }
  return dangling;
}

const server = new McpServer({ name: "jarvis-wiki", version: "0.1.0" });

server.tool(
  "wiki_search",
  "Search the wiki. Returns matching page paths with surrounding context lines.",
  { query: z.string().describe("case-insensitive substring or regex") },
  async ({ query }) => {
    let re: RegExp;
    try {
      re = new RegExp(query, "i");
    } catch {
      re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const hits: string[] = [];
    for (const page of listPages()) {
      const lines = readFileSync(abs(page), "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${page}:${i + 1}: ${lines[i]!.trim()}`);
          if (hits.length >= 40) break;
        }
      }
      if (hits.length >= 40) break;
    }
    return {
      content: [{ type: "text", text: hits.length ? hits.join("\n") : "no matches" }],
    };
  },
);

server.tool(
  "wiki_read",
  "Read a wiki page by repo-relative path (e.g. projects/jarvis.md). Also useful before showing it: <show type=\"markdown\" ref=\"wiki:PATH\"/> renders it on the stage.",
  { path: z.string() },
  async ({ path }) => {
    const p = path.endsWith(".md") ? path : `${path}.md`;
    if (!existsSync(abs(p))) {
      return {
        content: [{ type: "text", text: `no such page: ${p}\npages:\n${listPages().join("\n")}` }],
        isError: true,
      };
    }
    const content = readFileSync(abs(p), "utf8");
    return { content: [{ type: "text", text: `# ${p} (base-hash ${hashOf(content)})\n\n${content}` }] };
  },
);

server.tool(
  "wiki_context",
  "Ambient wiki context for the current turn: page inventory and recent changes.",
  {},
  async () => {
    const pages = listPages();
    const recent = pages
      .map((p) => ({ p, m: statSync(abs(p)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5)
      .map((x) => x.p);
    return {
      content: [
        {
          type: "text",
          text: `wiki: ${pages.length} pages\nrecently touched: ${recent.join(", ")}\nall: ${pages.join(", ")}`,
        },
      ],
    };
  },
);

server.tool(
  "wiki_propose_edit",
  "Propose a wiki edit (create or replace a page's full content). Returns a proposal id + unified diff to SHOW to Rafe (<show type=\"diff\">...) before committing. Never call wiki_commit without his explicit yes.",
  {
    path: z.string().describe("repo-relative page path, e.g. concepts/performance-engine.md"),
    content: z.string().describe("the complete new page content"),
    message: z.string().describe("one-line commit message"),
  },
  async ({ path, content, message }) => {
    const p = path.endsWith(".md") ? path : `${path}.md`;
    const file = abs(p);
    const oldContent = existsSync(file) ? readFileSync(file, "utf8") : "";
    const proposalId = randomUUID().slice(0, 8);
    const diff = unifiedDiff(p, oldContent, content);
    proposals.set(proposalId, {
      path: p,
      baseHash: oldContent ? hashOf(oldContent) : "",
      newContent: content,
      diff,
      message,
    });
    const dangling = lintLinks(content);
    const lintNote = dangling.length
      ? `\n\nnote: dangling [[links]] (pages that don't exist yet): ${dangling.join(", ")}`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `proposal ${proposalId} for ${p}\n\n${diff}${lintNote}\n\nShow this diff, get Rafe's yes, then wiki_commit with proposal_id="${proposalId}".`,
        },
      ],
    };
  },
);

server.tool(
  "wiki_commit",
  "Commit a previously proposed edit. MUTATE-CLASS: only after Rafe's explicit confirmation. Revalidates the base hash; if the page moved meanwhile, refuses and returns a rebased proposal instead.",
  { proposal_id: z.string() },
  async ({ proposal_id }) => {
    const prop = proposals.get(proposal_id);
    if (!prop) {
      return { content: [{ type: "text", text: `unknown or expired proposal: ${proposal_id}` }], isError: true };
    }
    const file = abs(prop.path);
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const currentHash = current ? hashOf(current) : "";
    if (currentHash !== prop.baseHash) {
      // the page moved under us — re-propose against the new base, never clobber
      proposals.delete(proposal_id);
      const newId = randomUUID().slice(0, 8);
      const diff = unifiedDiff(prop.path, current, prop.newContent);
      proposals.set(newId, { ...prop, baseHash: currentHash, diff });
      return {
        content: [
          {
            type: "text",
            text: `REFUSED: ${prop.path} changed since the proposal (the page moved under us). Rebased proposal ${newId}:\n\n${diff}\n\nExplain this to Rafe, show the new diff, and get a fresh yes.`,
          },
        ],
        isError: true,
      };
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, prop.newContent);
    // cwd works from a repo subdir too — git resolves the repo root upward
    execFileSync("git", ["add", prop.path], { cwd: wikiDir() });
    execFileSync("git", ["commit", "-m", prop.message], { cwd: wikiDir() });
    proposals.delete(proposal_id);
    const dangling = lintLinks(prop.newContent);
    const lintNote = dangling.length ? ` (dangling links: ${dangling.join(", ")})` : "";
    return { content: [{ type: "text", text: `committed ${prop.path}: "${prop.message}"${lintNote}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
