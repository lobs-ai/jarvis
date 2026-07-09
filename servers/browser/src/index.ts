// jarvis browser server — read and act use different mechanisms ON PURPOSE
// (design §Security model):
//   EYES  read Rafe's real Chrome via AppleScript. Two tiers:
//           ROSTER — title+url of every tab across every window (cheap).
//           DEEP   — active tab's selection + visible text.
//         Read-only; no debug port on the daily browser. Drill-down into
//         another tab needs no tool: the brain has a shell and can AppleScript
//         a specific tab itself.
//   HANDS act via CDP against a dedicated Jarvis-owned Chrome profile
//         (bin/jarvis chrome, :9222) — injection can't reach logged-in sessions.

import { execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium, type Browser, type Page } from "playwright-core";
import { z } from "zod";

const CDP_URL = process.env.JARVIS_CDP_URL ?? "http://127.0.0.1:9222";
const TEXT_LIMIT = 4000;
const TAB_CAP = 40; // tabs listed before we summarize the rest
const URL_CAP = 100; // chars per url in the roster

// ── eyes: AppleScript on the real Chrome ─────────────────────
function osascript(script: string): string | null {
  try {
    return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 2500 }).trimEnd();
  } catch {
    return null;
  }
}

function activeTabInfo(): { url: string; title: string } | null {
  const out = osascript(
    'tell application "Google Chrome" to if it is running then get (URL of active tab of front window) & "\\n" & (title of active tab of front window)',
  );
  if (!out) return null;
  const [url = "", title = ""] = out.split("\n");
  return { url, title };
}

function activeTabJs(js: string): string | null {
  // Requires Chrome: View → Developer → Allow JavaScript from Apple Events.
  const escaped = js.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return osascript(
    `tell application "Google Chrome" to execute front window's active tab javascript "${escaped}"`,
  );
}

// ROSTER: every tab, every window — title + url only (no per-tab JS, so it's
// cheap and doesn't need the Apple-Events toggle). Tab-separated rows:
//   <window#>\t<title>\t<url>
function chromeTabRoster(): string | null {
  const out = osascript(
    'tell application "Google Chrome"\n' +
      'set out to ""\n' +
      "set wi to 0\n" +
      "repeat with w in windows\n" +
      "set wi to wi + 1\n" +
      "repeat with t in tabs of w\n" +
      'set out to out & (wi as text) & tab & (title of t) & tab & (URL of t) & linefeed\n' +
      "end repeat\n" +
      "end repeat\n" +
      "return out\n" +
      "end tell",
  );
  if (!out) return null;
  const lines = out.split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const fmt = lines.slice(0, TAB_CAP).map((line) => {
    const [w = "?", title = "", url = ""] = line.split("\t");
    const u = url.length > URL_CAP ? url.slice(0, URL_CAP) + "…" : url;
    return `  [w${w}] ${title}  —  ${u}`;
  });
  const extra = lines.length > TAB_CAP ? `\n  … +${lines.length - TAB_CAP} more tabs` : "";
  return `open tabs (${lines.length}):\n${fmt.join("\n")}${extra}`;
}

// ── hands: CDP against the Jarvis-owned profile ──────────────
let browser: Browser | null = null;

async function jarvisChrome(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 2000 });
    return browser;
  } catch {
    throw new Error(
      "Jarvis's Chrome isn't running. Ask Rafe to run `bin/jarvis chrome` (a dedicated profile — never his daily browser).",
    );
  }
}

async function jarvisPage(): Promise<Page> {
  const b = await jarvisChrome();
  const ctx = b.contexts()[0] ?? (await b.newContext());
  return ctx.pages()[ctx.pages().length - 1] ?? (await ctx.newPage());
}

const server = new McpServer({ name: "jarvis-browser", version: "0.1.0" });

server.tool(
  "browser_context",
  "What Rafe is looking at in HIS browser (read-only): active tab url/title, selection, visible text, plus a roster of every open tab.",
  {},
  async () => {
    const info = activeTabInfo();
    const roster = chromeTabRoster();
    if (!info) {
      if (roster) return { content: [{ type: "text", text: roster }] };
      return { content: [{ type: "text", text: "Chrome is not running (or has no window)" }] };
    }
    let body = `active tab: ${info.title}\nurl: ${info.url}`;
    const selection = activeTabJs("window.getSelection().toString().slice(0, 800)");
    if (selection) body += `\nselection: ${selection}`;
    const text = activeTabJs(`document.body.innerText.slice(0, ${TEXT_LIMIT})`);
    if (text !== null) body += `\nvisible text:\n${text}`;
    else
      body +=
        "\n(page text unavailable — enable Chrome View → Developer → Allow JavaScript from Apple Events)";
    if (roster) body += `\n\n${roster}`;
    return { content: [{ type: "text", text: body }] };
  },
);

server.tool(
  "browser_open",
  "Open a URL in JARVIS's own browser (a dedicated profile) and show Rafe. Risk: navigate.",
  { url: z.string().url() },
  async ({ url }) => {
    const page = await jarvisPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    return { content: [{ type: "text", text: `opened ${url} — title: ${await page.title()}` }] };
  },
);

server.tool(
  "browser_read",
  "Read the current page in Jarvis's own browser (title, url, visible text).",
  {},
  async () => {
    const page = await jarvisPage();
    const text = await page.evaluate<string>(`document.body.innerText.slice(0, ${TEXT_LIMIT})`);
    return {
      content: [{ type: "text", text: `title: ${await page.title()}\nurl: ${page.url()}\n\n${text}` }],
    };
  },
);

server.tool(
  "browser_click",
  "Click an element (CSS selector or visible text) in Jarvis's own browser. Risk: mutate — requires Rafe's confirmation.",
  {
    selector: z.string().describe("CSS selector, or text=Visible Label"),
  },
  async ({ selector }) => {
    const page = await jarvisPage();
    await page.click(selector, { timeout: 5000 });
    return { content: [{ type: "text", text: `clicked ${selector} — now at ${page.url()}` }] };
  },
);

server.tool(
  "browser_type",
  "Type text into a field in Jarvis's own browser. Risk: mutate — requires Rafe's confirmation.",
  { selector: z.string(), text: z.string() },
  async ({ selector, text }) => {
    const page = await jarvisPage();
    await page.fill(selector, text, { timeout: 5000 });
    return { content: [{ type: "text", text: `typed into ${selector}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
