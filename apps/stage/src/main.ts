import { encodeBinaryFrame, type OrbState } from "@jarvis/protocol";
import { Wire } from "./wire.js";
import { Exhibits } from "./exhibits.js";
import { Player } from "./audio/player.js";
import { Mic } from "./audio/mic.js";
import { Endpointer } from "./audio/endpointer.js";

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
const thoughtLines = new Map<string, HTMLElement>();
let serverOrb: OrbState = "idle";
let utteranceActive = false; // declared before setOrb, which reads it on first call

function setOrb(state: OrbState): void {
  serverOrb = state;
  orb.dataset.state = utteranceActive ? "listening" : state;
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
  (playing) => {
    // Half-duplex: our own TTS through the speakers must not become an
    // utterance. While playing, mic frames are dropped (see Mic callback) and
    // any half-built utterance is abandoned. Interrupt via Esc, typing, or orb.
    if (playing && endpointer.cancel()) {
      wire.send({ type: "mic.cancel" });
      utteranceActive = false;
      setOrb(serverOrb);
    }
    micUi();
  },
);
let micSeq = 0;
const audioMeta = new Map<number, { turnId: string }>();

// ── mic switch (on/off toggle, energy endpointing — no hold) ─
const micToggle = $<HTMLButtonElement>("#micToggle");
const micLevel = $("#micLevel");
const micLevelFill = $("#micLevel .fill");
let micOn = false;
let level = 0;

const MIN_UTTER_MS = 350; // shorter → likely a cough/click; cancel, don't transcribe

const endpointer = new Endpointer({
  onUtteranceStart: () => {
    utteranceActive = true;
    setOrb(serverOrb);
    wire.send({ type: "mic.begin", sampleRate: 16000 });
  },
  onAudio: (pcm) => wire.sendBinary(encodeBinaryFrame(1, micSeq++, pcm)),
  onUtteranceEnd: (durMs) => {
    utteranceActive = false;
    setOrb(serverOrb);
    wire.send(durMs < MIN_UTTER_MS ? { type: "mic.cancel" } : { type: "mic.end" });
  },
  onLevel: (rms) => {
    level = Math.max(rms, level * 0.82); // fast attack, slow decay
    micLevelFill.style.width = `${Math.min(100, (level / 0.12) * 100)}%`;
  },
});

const mic = new Mic((pcm) => {
  if (!micOn) return;
  if (player.isPlaying) return; // half-duplex: drop frames while Jarvis talks
  endpointer.push(pcm);
});

function micUi(): void {
  micToggle.classList.toggle("on", micOn);
  micToggle.title = micOn ? "mic is on — click or Space to mute" : "mic is off — click or Space to listen";
  micLevel.classList.toggle("muted", !micOn || player.isPlaying);
  if (!micOn) micLevelFill.style.width = "0%";
}

async function toggleMic(): Promise<void> {
  if (!micOn) {
    player.arm();
    try {
      await mic.arm();
    } catch (err) {
      addLine("warn", `mic unavailable: ${String(err)}`);
      return;
    }
    micOn = true;
    mic.begin();
  } else {
    micOn = false;
    mic.end();
    if (endpointer.cancel()) wire.send({ type: "mic.cancel" });
    utteranceActive = false;
    setOrb(serverOrb);
  }
  micUi();
}

micToggle.addEventListener("click", () => void toggleMic());

function interruptPerformance(): void {
  player.flush();
  wire.send({ type: "interrupt" });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    interruptPerformance();
    return;
  }
  if (ev.code === "Space" && document.activeElement !== input && !ev.repeat) {
    ev.preventDefault();
    void toggleMic();
  }
});

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
        thoughtLines.delete(msg.turnId); // line stays in the rail as history
        return;
      case "heard":
        addLine("user", msg.text);
        return;
      case "thought": {
        // inner monologue: one dim line per turn, updated in place — proof of
        // life while Jarvis works or deliberately stays quiet
        let line = thoughtLines.get(msg.turnId);
        if (!line) {
          line = addLine("thought", msg.text);
          thoughtLines.set(msg.turnId, line);
        } else {
          line.textContent = msg.text;
          transcript.scrollTop = transcript.scrollHeight;
        }
        return;
      }
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

// orb: interrupt an active performance, otherwise focus the input
orb.addEventListener("click", () => {
  if (player.isPlaying || serverOrb === "speaking" || serverOrb === "thinking") {
    interruptPerformance();
    return;
  }
  input.focus();
});
input.focus();
micUi();
