// E2E sanity over the real WebSocket: send a text turn, expect thought lines
// (private workspace) and say items (speech) to arrive as distinct messages.
//
// GOTCHA: jarvisd is audience-of-one — the NEWEST /ws connection wins. If the
// stage is open in a browser, its auto-reconnect will replace this test's
// socket and the test will see nothing. Close the stage tab first.
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:7430/ws");
let sawThought = false;
let sawSay = false;
let done = false;

const finish = (why: string): void => {
  if (done) return;
  done = true;
  console.log(`\n=== ${why} ===`);
  console.log("thought stream:", sawThought ? "YES" : "NO");
  console.log("spoken say item:", sawSay ? "YES" : "NO");
  ws.close();
  process.exit(sawThought && sawSay ? 0 : 1);
};

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", quiet: true }));
  ws.send(
    JSON.stringify({
      type: "text.input",
      text: "quick check: run a shell command to count files in your own repo root (~/other/lobs/jarvis) and tell me the number",
    }),
  );
  setTimeout(() => finish("timeout 90s"), 90_000);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(String(data));
  if (msg.type === "thought") {
    sawThought = true;
    console.log(`[thought] ${String(msg.text).slice(-120).replace(/\n/g, " ⏎ ")}`);
  } else if (msg.type === "item" && msg.item?.kind === "say") {
    sawSay = true;
    console.log(`[say] ${msg.item.text}`);
  } else if (msg.type === "state") {
    console.log(`[orb] ${msg.orb}`);
  } else if (msg.type === "turn.end") {
    setTimeout(() => finish("turn ended"), 500);
  } else if (msg.type === "error") {
    console.log(`[error] ${msg.message}`);
  }
});
