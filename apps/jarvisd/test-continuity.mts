// Probe: does conversation context survive across turns in one CliBrain?
// (system/init events print "child ready" per query — this checks whether
// that's benign logging or an actual per-turn respawn losing history.)
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CliBrain } from "./src/brain/cli-brain.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TSX = fileURLToPath(new URL("./node_modules/.bin/tsx", import.meta.url));

const brain = new CliBrain({
  model: "claude-opus-4-8",
  servers: [{ name: "speech", command: TSX, args: [join(REPO, "servers/speech/src/index.ts")] }],
  allowedTools: ["mcp__speech__say"],
  disallowedTools: ["Edit", "Write", "NotebookEdit", "TodoWrite", "Bash"],
  facts: () => null,
});

async function turn(text: string): Promise<string> {
  let spoken = "";
  await brain.turn(
    text,
    { onTextDelta: (d) => (spoken += d), onToolCall: () => {} },
    new AbortController().signal,
  );
  console.log(`>>> ${text}\n<<< ${spoken.trim()}\n`);
  return spoken;
}

await turn("remember the word pamplemousse. just say ok.");
const s2 = await turn("what word did I ask you to remember?");
console.log("continuity:", /pamplemousse/i.test(s2) ? "YES" : "NO — HISTORY LOST");
brain.dispose();
process.exit(0);
