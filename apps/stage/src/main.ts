import { encodeBinaryFrame, type OrbState } from "@jarvis/protocol";
import { Wire } from "./wire.js";
import { Exhibits } from "./exhibits.js";
import { Player } from "./audio/player.js";
import { Mic } from "./audio/mic.js";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const orb = $("#orb");
const transcript = $("#transcript");
const input = $<HTMLInputElement>("#input");
const inputForm = $<HTMLFormElement>("#inputForm");
const quietToggle = $<HTMLButtonElement>("#quietToggle");
const conn = $("#conn");
const exhibits = new Exhibits($("#exhibits"));

let quiet = false;
let currentJarvisLine: HTMLElement | null = null;
let currentTurnId: string | null = null;
let serverOrb: OrbState = "idle";
let pushingToTalk = false; // declared before setOrb, which reads it on first call

function setOrb(state: OrbState): void {
  serverOrb = state;
  orb.dataset.state = pushingToTalk ? "listening" : state;
}
setOrb("idle");

function addLine(cls: string, text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  div.textContent = text;
  transcript.appendChild(div);
  transcript.scrollTop = transcript.scrollHeight;
  while (transcript.children.length > 200) transcript.firstChild?.remove();
  return div;
}

// ── audio ────────────────────────────────────────────────────
const player = new Player(
  (turnId, seq) => wire.send({ type: "played", turnId, seq }),
  () => {
    /* half-duplex: PTT is manual, so playing state only affects barge-in below */
  },
);
let micSeq = 0;
const mic = new Mic((pcm) => wire.sendBinary(encodeBinaryFrame(1, micSeq++, pcm)));
const audioMeta = new Map<number, { turnId: string }>();

async function armAudio(): Promise<void> {
  player.arm();
  if (!mic.isArmed) {
    try {
      await mic.arm();
    } catch (err) {
      addLine("warn", `mic unavailable: ${String(err)}`);
    }
  }
}

// ── push-to-talk (v0 gesture; open-mic VAD is a later phase) ─
async function pttDown(): Promise<void> {
  if (pushingToTalk) return;
  pushingToTalk = true;
  await armAudio();
  // talking over Jarvis IS barge-in: stop playback, tell the daemon
  if (player.isPlaying || serverOrb === "speaking" || serverOrb === "thinking") {
    player.flush();
    wire.send({ type: "interrupt" });
  }
  orb.dataset.state = "listening";
  wire.send({ type: "mic.begin", sampleRate: 16000 });
  mic.begin();
}

function pttUp(): void {
  if (!pushingToTalk) return;
  pushingToTalk = false;
  mic.end();
  wire.send({ type: "mic.end" });
  orb.dataset.state = serverOrb;
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    player.flush();
    wire.send({ type: "interrupt" });
    return;
  }
  if (ev.code === "Space" && document.activeElement !== input && !ev.repeat) {
    ev.preventDefault();
    void pttDown();
  }
});
document.addEventListener("keyup", (ev) => {
  if (ev.code === "Space" && pushingToTalk) {
    ev.preventDefault();
    pttUp();
  }
});
orb.addEventListener("mousedown", () => void pttDown());
orb.addEventListener("mouseup", () => pttUp());
orb.addEventListener("mouseleave", () => pttUp());

// ── wire ─────────────────────────────────────────────────────
const wire = new Wire({
  onOpen: () => {
    conn.classList.add("on");
    wire.send({ type: "hello", quiet });
  },
  onClose: () => conn.classList.remove("on"),
  onAudio: (streamId, seq, pcm) => {
    const meta = audioMeta.get(streamId);
    if (meta) player.enqueue(meta.turnId, seq, pcm);
    audioMeta.delete(streamId);
  },
  onMessage: (msg) => {
    switch (msg.type) {
      case "state":
        setOrb(msg.orb);
        return;
      case "turn.begin":
        currentTurnId = msg.turnId;
        currentJarvisLine = null;
        return;
      case "turn.end":
        if (currentTurnId === msg.turnId) currentTurnId = null;
        currentJarvisLine?.classList.remove("speaking");
        currentJarvisLine = null;
        return;
      case "heard":
        addLine("user", msg.text);
        return;
      case "item": {
        const item = msg.item;
        if (item.kind === "say") {
          currentJarvisLine?.classList.remove("speaking");
          currentJarvisLine = addLine("jarvis speaking", item.text);
          return;
        }
        if (item.kind === "show") return exhibits.show(item.turnId, item.id, item.exhibit);
        if (item.kind === "update") return exhibits.update(item.turnId, item.ref, item.body);
        if (item.kind === "dismiss") return exhibits.dismiss(item.turnId, item.ref);
        return; // act items surface in M4
      }
      case "audio.segment":
        audioMeta.set(msg.streamId, { turnId: msg.turnId });
        return;
      case "confirm.request": {
        // pending-confirmation card: click always works; spoken yes must
        // exactly match one of msg.phrases (enforced daemon-side)
        const card = document.createElement("div");
        card.className = "exhibit confirm-card";
        card.dataset.confirmId = msg.confirmId;
        card.innerHTML =
          `<header><span>confirm</span><span class="etype">mutate</span></header>` +
          `<div class="body"><p>${msg.summary.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>` +
          (msg.detail ? `<pre><code>${msg.detail.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</code></pre>` : "") +
          `<p class="placeholder">say "${msg.phrases[0]}" or click:</p>` +
          `<button class="approve">approve</button> <button class="deny">deny</button></div>`;
        card.querySelector(".approve")!.addEventListener("click", () =>
          wire.send({ type: "confirm", confirmId: msg.confirmId, approve: true }),
        );
        card.querySelector(".deny")!.addEventListener("click", () =>
          wire.send({ type: "confirm", confirmId: msg.confirmId, approve: false }),
        );
        $("#exhibits").appendChild(card);
        return;
      }
      case "confirm.resolved": {
        document
          .querySelectorAll<HTMLElement>(`[data-confirm-id="${msg.confirmId}"]`)
          .forEach((el) => el.remove());
        return;
      }
      case "error":
        addLine("warn", msg.message);
        return;
    }
  },
});
wire.connect();

// ── text input (barge-in by design when a performance is active) ─
inputForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addLine("user", text);
  if (player.isPlaying) player.flush();
  wire.send({ type: "text.input", text });
  input.value = "";
});

quietToggle.addEventListener("click", () => {
  quiet = !quiet;
  quietToggle.textContent = quiet ? "🔇" : "🔊";
  wire.send({ type: "quiet.set", quiet });
});

// tap-to-wake: arms audio (the required user gesture) and focuses input
orb.addEventListener("click", () => {
  void armAudio();
  input.focus();
});
input.focus();
