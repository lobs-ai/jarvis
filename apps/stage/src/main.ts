import { encodeBinaryFrame, type OrbState } from "@jarvis/protocol";
import { Wire } from "./wire.js";
import { Exhibits } from "./exhibits.js";
import { Player } from "./audio/player.js";
import { Mic } from "./audio/mic.js";
import { Endpointer } from "./audio/endpointer.js";
import { $ } from "./dom.js";
import { Transcript } from "./ui/transcript.js";
import { Activity } from "./ui/activity.js";
import { Toasts } from "./ui/toast.js";
import { Settings } from "./ui/settings.js";
import { Tabs } from "./ui/tabs.js";
import { Wiki } from "./ui/wiki.js";
import { StatusStrip, type Health } from "./ui/statusstrip.js";
import { Lightbox } from "./ui/lightbox.js";
import { reloadIfStale } from "./reload.js";

// ── elements ─────────────────────────────────────────────────
const orb = $("#orb");
const statusEl = $("#status");
const stateLabel = $("#stateLabel");
const conn = $("#conn");
const input = $<HTMLInputElement>("#input");
const inputForm = $<HTMLFormElement>("#inputForm");
const quietToggle = $<HTMLButtonElement>("#quietToggle");
const quietState = $("#quietState");
const quietIcon = $(".control-icon", quietToggle);
const newConvo = $<HTMLButtonElement>("#newConvo");
const exhibitsEl = $("#exhibits");
const clearExhibits = $<HTMLButtonElement>("#clearExhibits");

// ── UI modules ───────────────────────────────────────────────
const transcript = new Transcript($("#transcript"), $("#conversationPane"));
const toasts = new Toasts($("#toasts"));
const lightbox = new Lightbox();
const exhibits = new Exhibits(
  exhibitsEl,
  (card) => lightbox.open(card), // click a card → maximize
  (card) => lightbox.closeIfShowing(card), // card evicted/swept → drop the lightbox
);
const statusStrip = new StatusStrip();

const wiki = new Wiki((path, title) => {
  // Clicking a page/result lands it on the stage as a markdown exhibit; the
  // "wiki-browser" turnId namespaces these apart from the model's own exhibits.
  exhibits.show("wiki-browser", path, { type: "markdown", ref: `wiki:${path}`, title });
});

const tabs = new Tabs($(".tabbar"), $("#tabBody"), (name) => {
  if (name === "wiki") wiki.ensureLoaded();
});

const activity = new Activity($("#activity"), $("#activityPane"), () => tabs.badge("activity"));

const settings = new Settings({
  onApply: (patch) => wire.send({ type: "settings.set", patch }),
});

// ── conversation state ───────────────────────────────────────
let quiet = false;
let connected = false;
let everConnected = false;
let currentJarvisLine: HTMLElement | null = null;
let currentTurnId: string | null = null;
const thoughtLines = new Map<string, HTMLElement>();
let serverOrb: OrbState = "idle";
let utteranceActive = false; // declared before renderState, which reads it

// Single source of truth for the orb + top-bar state label. Offline (WS closed)
// and the local "speaking into the mic" listening state both override the
// server's reported orb.
function renderState(): void {
  const effective = !connected
    ? everConnected
      ? "offline"
      : "connecting"
    : utteranceActive
      ? "listening"
      : serverOrb;
  orb.dataset.state = effective;
  statusEl.dataset.state = effective;
  stateLabel.textContent = effective;
}

function setOrb(state: OrbState): void {
  serverOrb = state;
  renderState();
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
      renderState();
    }
    micUi();
  },
);
let micSeq = 0;
const audioMeta = new Map<number, { turnId: string }>();

// ── mic switch (on/off toggle, energy endpointing — no hold) ─
const micToggle = $<HTMLButtonElement>("#micToggle");
const micState = $("#micState");
const micLevel = $("#micLevel");
const micLevelFill = $("#micLevel .fill");
let micOn = false;
let level = 0;

const MIN_UTTER_MS = 350; // shorter → likely a cough/click; cancel, don't transcribe

const endpointer = new Endpointer({
  onUtteranceStart: () => {
    utteranceActive = true;
    renderState();
    wire.send({ type: "mic.begin", sampleRate: 16000 });
  },
  onAudio: (pcm) => wire.sendBinary(encodeBinaryFrame(1, micSeq++, pcm)),
  onUtteranceEnd: (durMs) => {
    utteranceActive = false;
    renderState();
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
  micToggle.setAttribute("aria-pressed", String(micOn));
  micState.textContent = micOn ? "on" : "off";
  micToggle.title = micOn
    ? "Mic is on — click or press Space to mute"
    : "Mic is off — click or press Space to listen";
  micLevel.classList.toggle("muted", !micOn || player.isPlaying);
  if (!micOn) micLevelFill.style.width = "0%";
}

async function toggleMic(): Promise<void> {
  if (!micOn) {
    player.arm();
    try {
      await mic.arm();
    } catch (err) {
      const msg = `Mic unavailable: ${String(err)}`;
      transcript.addLine("warn", msg);
      toasts.show(msg, "error");
      return;
    }
    micOn = true;
    mic.begin();
  } else {
    micOn = false;
    mic.disarm();
    if (endpointer.cancel()) wire.send({ type: "mic.cancel" });
    utteranceActive = false;
    renderState();
  }
  micUi();
}

micToggle.addEventListener("click", () => void toggleMic());

// ── new conversation ─────────────────────────────────────────
newConvo.addEventListener("click", () => {
  if (player.isPlaying) player.flush();
  wire.send({ type: "session.new" });
});

function clearRoom(): void {
  transcript.clear();
  activity.clear();
  thoughtLines.clear();
  currentJarvisLine = null;
  currentTurnId = null;
  lightbox.closeIfAny();
  exhibits.dismiss("", "all");
  transcript.addLine("sys", "— new conversation —");
}

function interruptPerformance(): void {
  player.flush();
  wire.send({ type: "interrupt" });
}

// ── stage panel clear-all (shown at 2+ dismissable exhibits) ─
function refreshExhibits(): void {
  const total = exhibitsEl.querySelectorAll(".exhibit").length;
  exhibitsEl.classList.toggle("has-cards", total > 0);
  const dismissable = exhibitsEl.querySelectorAll(
    ".exhibit:not(.confirm-card):not(.dismissing)",
  ).length;
  clearExhibits.classList.toggle("hidden", dismissable < 2);
}
new MutationObserver(refreshExhibits).observe(exhibitsEl, { childList: true });
clearExhibits.addEventListener("click", () => exhibits.dismiss("", "all"));

// ── keyboard shortcuts ───────────────────────────────────────
function isTyping(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLButtonElement
  );
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    // priority: lightbox > settings drawer > interrupt the performance
    if (lightbox.isOpen) lightbox.close();
    else if (settings.isOpen) settings.close();
    else interruptPerformance();
    return;
  }
  // Space toggles the mic, but only when the user isn't typing or in settings.
  if (ev.code === "Space" && !ev.repeat && !settings.isOpen && !isTyping()) {
    ev.preventDefault();
    void toggleMic();
  }
});

// ── status health poll (GET /status; degrades to unknown) ────
async function pollStatus(): Promise<void> {
  try {
    const res = await fetch("/status", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    statusStrip.setHealth((await res.json()) as Health);
  } catch {
    statusStrip.setHealth(null);
  }
}
window.setInterval(() => void pollStatus(), 10_000);

// ── wire ─────────────────────────────────────────────────────
const wire = new Wire({
  onOpen: () => {
    connected = true;
    conn.classList.add("on");
    if (everConnected) toasts.show("Reconnected to Jarvis.", "success");
    everConnected = true;
    renderState();
    wire.send({ type: "hello", quiet });
    void pollStatus();
    // A daemon that restarted with a new build serves a freshly-hashed bundle;
    // reload once if the tab is still running the old one.
    void reloadIfStale();
  },
  onClose: () => {
    const wasConnected = connected;
    connected = false;
    conn.classList.remove("on");
    renderState();
    if (wasConnected) toasts.show("Connection lost — reconnecting…", "error");
  },
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
        activity.turnStart(msg.source);
        return;
      case "turn.end":
        if (currentTurnId === msg.turnId) currentTurnId = null;
        currentJarvisLine?.classList.remove("speaking");
        currentJarvisLine = null;
        thoughtLines.delete(msg.turnId); // line stays in the rail as history
        activity.turnEnd(msg.turnId);
        return;
      case "heard":
        transcript.addLine("user", msg.text);
        return;
      case "thought": {
        // inner monologue: one dim line per turn in conversation, updated in
        // place; the activity tab keeps the same evolving entry with a timestamp
        let line = thoughtLines.get(msg.turnId);
        if (!line) {
          line = transcript.addLine("thought", msg.text);
          thoughtLines.set(msg.turnId, line);
        } else {
          line.textContent = msg.text;
          transcript.scrollToEnd();
        }
        activity.thought(msg.turnId, msg.text);
        return;
      }
      case "item": {
        const item = msg.item;
        if (item.kind === "say") {
          currentJarvisLine?.classList.remove("speaking");
          currentJarvisLine = transcript.addLine("jarvis speaking", item.text);
          return;
        }
        if (item.kind === "show") return exhibits.show(item.turnId, item.id, item.exhibit);
        if (item.kind === "update") return exhibits.update(item.turnId, item.ref, item.body);
        if (item.kind === "dismiss") return exhibits.dismiss(item.turnId, item.ref);
        if (item.kind === "act") return activity.tool(item.tool, item.risk);
        if (item.kind === "focus") {
          // Jarvis maximizes/zooms an exhibit; "none" closes. Unknown ref → ignore.
          if (item.ref === "none") return lightbox.closeIfAny();
          const card = exhibits.resolveCard(item.turnId, item.ref);
          if (card) lightbox.open(card, item.zoom);
          return;
        }
        return;
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
          `<header><span class="etitle">Confirm</span><span class="hmeta"><span class="etype">mutate</span></span></header>` +
          `<div class="body"><p>${escapeInline(msg.summary)}</p>` +
          (msg.detail ? `<pre><code>${escapeInline(msg.detail)}</code></pre>` : "") +
          `<p class="placeholder">say “${escapeInline(msg.phrases[0] ?? "yes")}” or click:</p>` +
          `<div class="actions"><button class="approve" type="button">Approve</button>` +
          `<button class="deny" type="button">Deny</button></div></div>`;
        card.querySelector(".approve")!.addEventListener("click", () =>
          wire.send({ type: "confirm", confirmId: msg.confirmId, approve: true }),
        );
        card.querySelector(".deny")!.addEventListener("click", () =>
          wire.send({ type: "confirm", confirmId: msg.confirmId, approve: false }),
        );
        exhibitsEl.appendChild(card);
        return;
      }
      case "confirm.resolved": {
        document
          .querySelectorAll<HTMLElement>(`[data-confirm-id="${msg.confirmId}"]`)
          .forEach((el) => el.remove());
        return;
      }
      case "session.reset":
        clearRoom();
        toasts.show("Started a new conversation.", "info");
        return;
      case "settings":
        settings.populate(msg.settings);
        statusStrip.setSettings(msg.settings);
        if (msg.note) toasts.show(msg.note, "info");
        return;
      case "error":
        transcript.addLine("warn", msg.message);
        activity.note("warn", msg.message);
        toasts.show(msg.message, "error");
        return;
    }
  },
});
wire.connect();

// Inline HTML escape for the confirm card's server-provided strings.
function escapeInline(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ── text input (barge-in by design when a performance is active) ─
inputForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  transcript.addLine("user", text);
  if (player.isPlaying) player.flush();
  wire.send({ type: "text.input", text });
  input.value = "";
});

// ── voice/quiet toggle (quiet = captions only, no TTS audio) ──
quietToggle.addEventListener("click", () => {
  quiet = !quiet;
  const voiceOn = !quiet;
  quietToggle.classList.toggle("on", voiceOn);
  quietToggle.setAttribute("aria-pressed", String(voiceOn));
  quietState.textContent = voiceOn ? "on" : "off";
  quietIcon.textContent = voiceOn ? "🔊" : "🔇";
  quietToggle.title = voiceOn
    ? "Voice on — click for captions only"
    : "Captions only — click to hear Jarvis speak";
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

renderState();
micUi();
refreshExhibits();
input.focus();
