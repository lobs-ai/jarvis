import type { OrbState } from "@jarvis/protocol";
import { Wire } from "./wire.js";
import { Exhibits } from "./exhibits.js";

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

function setOrb(state: OrbState): void {
  orb.dataset.state = state;
}
setOrb("idle");

function addLine(cls: string, text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  div.textContent = text;
  transcript.appendChild(div);
  transcript.scrollTop = transcript.scrollHeight;
  // keep the rail from growing unboundedly
  while (transcript.children.length > 200) transcript.firstChild?.remove();
  return div;
}

const wire = new Wire({
  onOpen: () => {
    conn.classList.add("on");
    wire.send({ type: "hello", quiet });
  },
  onClose: () => conn.classList.remove("on"),
  onAudio: (_streamId, seq, pcm) => {
    // M1: hand to the audio player; ack when playback finishes.
    void seq;
    void pcm;
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
        return; // M1
      case "confirm.request":
        // M2+: pending-confirmation card; for now surface as a caption
        addLine("warn", `confirm requested: ${msg.summary}`);
        return;
      case "confirm.resolved":
        return;
      case "error":
        addLine("warn", msg.message);
        return;
    }
  },
});
wire.connect();

inputForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  addLine("user", text);
  // typing during a performance is barge-in by design; jarvisd handles it
  wire.send({ type: "text.input", text });
  input.value = "";
});

// Escape interrupts an active performance.
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") wire.send({ type: "interrupt" });
});

quietToggle.addEventListener("click", () => {
  quiet = !quiet;
  quietToggle.textContent = quiet ? "🔇" : "🔊";
  wire.send({ type: "quiet.set", quiet });
});

// The orb is the M1 push-to-talk / tap-to-wake gesture; the click also arms the
// AudioContext (browser gesture requirement). M0: it just focuses the input.
orb.addEventListener("click", () => input.focus());
input.focus();
