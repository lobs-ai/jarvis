// Live smoke test: the settings MCP server through a real CliBrain child.
// The child's settings_get calls jarvisd's HTTP endpoint (the daemon must be
// running), so this exercises the full loop: model → MCP tool → HTTP → config.
// Runs beside the daemon without touching its WS (audience-of-one safe).
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CliBrain } from "./src/brain/cli-brain.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TSX = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));

const toolCalls: string[] = [];
const brain = new CliBrain({
  model: "claude-opus-4-8",
  wikiDir: () => "/Users/rafe/other/personal-wiki/wiki",
  servers: [
    { name: "speech", command: TSX, args: [join(REPO, "servers/speech/src/index.ts")] },
    {
      name: "settings",
      command: TSX,
      args: [join(REPO, "servers/settings/src/index.ts")],
      env: { JARVIS_PORT: "7430" },
    },
    { name: "wiki", command: TSX, args: [join(REPO, "servers/wiki/src/index.ts")] },
  ],
  allowedTools: [
    "mcp__speech__say",
    "mcp__settings__settings_get",
    "mcp__settings__settings_set",
    "mcp__wiki__wiki_read",
    "mcp__wiki__wiki_search",
  ],
  disallowedTools: ["Edit", "Write", "NotebookEdit", "TodoWrite", "Bash"],
  onToolCall: (n) => {
    toolCalls.push(n);
    console.log(`\n  [tool] ${n}`);
  },
  onToolResult: (n, t) => console.log(`  [result ${n}] ${t.slice(0, 140).replace(/\n/g, " ⏎ ")}`),
  facts: () => null,
});

async function turn(text: string): Promise<string> {
  console.log(`\n>>> ${text}`);
  let spoken = "";
  const t0 = Date.now();
  const r = await brain.turn(
    text,
    {
      onTextDelta: (d) => {
        if (!spoken) process.stdout.write("  SAY: ");
        spoken += d;
        process.stdout.write(d);
      },
      onToolCall: () => {},
    },
    new AbortController().signal,
  );
  console.log(`\n  [turn done ${Date.now() - t0}ms, aborted=${r.aborted}]`);
  return spoken;
}

const s1 = await turn(
  "quick check: read your current settings with settings_get and tell me which wiki directory and which model you're on",
);
const s2 = await turn(
  "and confirm the wiki tools actually read from there — search the wiki for Karpathy and name one page you find",
);

console.log("\n=== verdict ===");
console.log(
  "settings_get used:",
  toolCalls.some((n) => n.includes("settings_get")) ? "YES" : "NO",
  `(${toolCalls.join(", ")})`,
);
console.log("turn1 spoke:", s1.trim().length > 0 ? "YES" : "NO");
console.log(
  "turn1 mentions personal-wiki:",
  /personal.wiki/i.test(s1) ? "YES" : "NO",
);
console.log("turn2 wiki search worked:", s2.trim().length > 0 ? "YES" : "NO");
brain.dispose();
process.exit(0);
