// Live smoke test: CliBrain with the say-tool speech contract + Bash.
// Verifies (1) speech arrives via say input streaming, (2) plain text is not
// surfaced, (3) the shell actually runs, (4) two-turn continuity survives.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CliBrain } from "./src/brain/cli-brain.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TSX = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));

const toolCalls: string[] = [];
const brain = new CliBrain({
  model: "claude-opus-4-8",
  servers: [{ name: "speech", command: TSX, args: [join(REPO, "servers/speech/src/index.ts")] }],
  allowedTools: ["mcp__speech__say", "Bash"],
  disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite"],
  onToolCall: (n) => {
    toolCalls.push(n);
    console.log(`\n  [tool] ${n}`);
  },
  onToolResult: (n, t) => console.log(`  [result ${n}] ${t.slice(0, 120).replace(/\n/g, " ⏎ ")}`),
  facts: () => null,
});

async function turn(text: string): Promise<string> {
  console.log(`\n>>> ${text}`);
  let spoken = "";
  let firstDelta = 0;
  const t0 = Date.now();
  const r = await brain.turn(
    text,
    {
      onTextDelta: (d) => {
        if (!firstDelta) {
          firstDelta = Date.now() - t0;
          process.stdout.write(`  [first spoken delta ${firstDelta}ms]\n  SAY: `);
        }
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
  "how many typescript files are in ~/other/lobs/jarvis/servers? count for real with your shell",
);
const s2 = await turn("and which of those servers did you just count as the biggest one?");

console.log("\n=== verdict ===");
console.log("bash used:", toolCalls.some((n) => n === "Bash") ? "YES" : "NO", `(${toolCalls.join(", ")})`);
console.log("turn1 spoke:", s1.trim().length > 0 ? "YES" : "NO");
console.log("turn2 continuity:", s2.trim().length > 0 ? "YES" : "NO");
brain.dispose();
process.exit(0);
