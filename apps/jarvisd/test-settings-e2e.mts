// E2E over the real WebSocket: settings snapshot on connect, settings.get,
// session.new → session.reset, then a live turn where the model reads its own
// configuration through the settings MCP server (CLI child → HTTP → jarvisd).
//
// GOTCHA: jarvisd is audience-of-one — the NEWEST /ws connection wins. If the
// stage is open in a browser, its auto-reconnect will replace this test's
// socket and the test will see nothing. Close the stage tab first.
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:7430/ws");
let sawSettingsOnConnect = false;
let sawReset = false;
let saySpoken = "";
let done = false;

const finish = (why: string): void => {
  if (done) return;
  done = true;
  console.log(`\n=== ${why} ===`);
  console.log("settings on connect:", sawSettingsOnConnect ? "YES" : "NO");
  console.log("session.reset:", sawReset ? "YES" : "NO");
  console.log("spoke about settings:", saySpoken.trim() ? "YES" : "NO", `("${saySpoken.trim().slice(0, 160)}")`);
  ws.close();
  process.exit(sawSettingsOnConnect && sawReset && saySpoken.trim() ? 0 : 1);
};

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", quiet: true }));
  setTimeout(() => ws.send(JSON.stringify({ type: "session.new" })), 300);
  setTimeout(() => {
    ws.send(
      JSON.stringify({
        type: "text.input",
        text: "quick check: use settings_get and tell me which wiki directory and model you're running on",
      }),
    );
  }, 800);
  setTimeout(() => finish("timeout 90s"), 90_000);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(String(data));
  if (msg.type === "settings") {
    sawSettingsOnConnect = true;
    console.log(`[settings] ${JSON.stringify(msg.settings)}${msg.note ? ` note=${msg.note}` : ""}`);
  } else if (msg.type === "session.reset") {
    sawReset = true;
    console.log("[session.reset]");
  } else if (msg.type === "thought") {
    console.log(`[thought] ${String(msg.text).slice(-100).replace(/\n/g, " ⏎ ")}`);
  } else if (msg.type === "item" && msg.item?.kind === "say") {
    saySpoken += msg.item.text + " ";
    console.log(`[say] ${msg.item.text}`);
  } else if (msg.type === "turn.end") {
    setTimeout(() => finish("turn ended"), 500);
  } else if (msg.type === "error") {
    console.log(`[error] ${msg.message}`);
  }
});
