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
const ssStop = $<HTMLButtonElement>("#ssStop");

// ── UI modules ───────────────────────────────────────────────
const transcript = new Transcript($("#transcript"), $("#conversationPane"));
const toasts = new Toasts($("#toasts"));
const lightbox = new Lightbox();

// Stage-fault reporting: when the model's performance breaks on screen (or in
// the speakers), tell jarvisd — it folds faults into a corrective system turn
// so the model fixes its own show without Rafe having to say "that broke".
function reportFault(
  kind: "exhibit-unresolved" | "missing-target" | "diagram-error" | "audio-blocked" | "audio-error",
  detail: string,
  turnId?: string,
): void {
  if (turnId === "wiki-browser") return; // Rafe's own browsing, not the model's show
  wire.send({ type: "stage.fault", kind, detail: detail.slice(0, 400), turnId });
}

const exhibits = new Exhibits(
  exhibitsEl,
  (card) => lightbox.open(card), // click a card → maximize
  (card) => lightbox.closeIfShowing(card), // card evicted/swept → drop the lightbox
  reportFault,
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

const activity = new Activity($("#activityPane"), {
  onSubagentSend: (id, message) => wire.send({ type: "subagent.send", id, message }),
  onSubagentStop: (id) => wire.send({ type: "subagent.stop", id }),
  onUnread: () => tabs.badge("activity"),
});

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
  // tap-to-interrupt affordance: presence must never depend solely on the
  // risky acoustic path (design §4 Layer 4)
  const busy = effective === "speaking" || effective === "thinking" || effective === "acting";
  ssStop.classList.toggle("hidden", !busy);
}

function setOrb(state: OrbState): void {
  serverOrb = state;
  renderState();
}

// ── audio ────────────────────────────────────────────────────
const player = new Player(
  (turnId, seq) => wire.send({ type: "played", turnId, seq }),
  (playing) => {
    // Half-duplex fallback (no AEC): our own TTS through the speakers must not
    // become an utterance — abandon any half-built one when playback starts.
    // With AEC active the mic stays hot and §6.2's duck/commit machine rules.
    if (playing && !player.aecActive && endpointer.cancel()) {
      wire.send({ type: "mic.cancel" });
      utteranceActive = false;
      renderState();
    }
    if (!playing) {
      if (bargePending) {
        // playback drained while we were ducked-and-buffering: nothing left to
        // interrupt — promote the buffered speech to a normal utterance
        bargePending = false;
        beginUtterance();
        flushBargeBuffer();
      }
      // Jarvis finished on his own while a barge was streaming: there's no
      // performance left to cut, so it's just a normal utterance now.
      bargeCommitted = false;
      player.unduck(); // never leave the gain low between performances
    }
    micUi();
  },
  reportFault,
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

// ── barge-in (§6.2): duck immediately, cut only on real WORDS ──
// Three stages while Jarvis speaks:
//   1. first voice-like energy → DUCK the TTS (cheap, reversible).
//   2. sustained energy past the gate → open a server utterance and stream it
//      for STT, still ducked (bargeCommitted). We do NOT stop Jarvis here —
//      energy alone is a cough, leaked TTS, or room noise as often as speech.
//   3. the server transcribes and rules: real words → "barge:cut" (flush the
//      old performance); nothing → "barge:resume" (un-duck, keep talking).
// Only recognized speech ever interrupts Jarvis. Audio is buffered between
// duck and stream so a committed utterance loses nothing.
const BARGE_COMMIT_MS = 550;
let bargePending = false; // ducked, buffering, not yet streaming (pre-gate)
let bargeCommitted = false; // ducked and streaming to STT, awaiting the verdict
let bargeBuffer: Uint8Array[] = [];
let bargeBufferedMs = 0;

function beginUtterance(): void {
  utteranceActive = true;
  renderState();
  wire.send({ type: "mic.begin", sampleRate: 16000 });
}

function flushBargeBuffer(): void {
  for (const pcm of bargeBuffer) wire.sendBinary(encodeBinaryFrame(1, micSeq++, pcm));
  bargeBuffer = [];
  bargeBufferedMs = 0;
}

function commitBarge(): void {
  // Sustained voice-like energy: promote from ducked-buffering to ducked-and-
  // streaming. Open the server utterance so STT can rule on it, but keep Jarvis
  // ducked (not flushed) and send NO interrupt — only real words, confirmed by
  // the server's "barge:cut", ever stop him. A resume verdict un-ducks instead.
  bargePending = false;
  bargeCommitted = true;
  beginUtterance();
  flushBargeBuffer();
}

const endpointer = new Endpointer({
  onUtteranceStart: () => {
    if (player.isPlaying && player.aecActive) {
      // speaking → ducked: don't open a server utterance yet — the commit gate
      // decides whether this becomes an interrupt or melts back into playback
      bargePending = true;
      bargeBuffer = [];
      bargeBufferedMs = 0;
      player.duck();
      return;
    }
    beginUtterance();
  },
  onAudio: (pcm) => {
    if (bargePending) {
      bargeBuffer.push(pcm);
      bargeBufferedMs += (pcm.byteLength / 2 / 16000) * 1000;
      if (bargeBufferedMs >= BARGE_COMMIT_MS) commitBarge();
      return;
    }
    wire.sendBinary(encodeBinaryFrame(1, micSeq++, pcm));
  },
  onUtteranceEnd: (durMs) => {
    if (bargePending) {
      // ducked but never committed — it was nothing; resume the performance
      bargePending = false;
      bargeBuffer = [];
      bargeBufferedMs = 0;
      player.unduck();
      return;
    }
    utteranceActive = false;
    renderState();
    // A committed barge stays ducked until the server's verdict, so it must end
    // with mic.end (STT runs, verdict returns) — never mic.cancel, which would
    // strand the duck. Only genuinely short idle blips cancel.
    const end = bargeCommitted || durMs >= MIN_UTTER_MS;
    wire.send(end ? { type: "mic.end" } : { type: "mic.cancel" });
  },
  onLevel: (rms) => {
    level = Math.max(rms, level * 0.82); // fast attack, slow decay
    micLevelFill.style.width = `${Math.min(100, (level / 0.12) * 100)}%`;
  },
});

const mic = new Mic((pcm) => {
  if (!micOn) return;
  // Full duplex only when AEC cancels our own TTS from the mic; otherwise keep
  // the half-duplex gate (fallbacks: headphones, tap-to-interrupt).
  if (player.isPlaying && !player.aecActive) return;
  endpointer.push(pcm);
});

function micUi(): void {
  micToggle.classList.toggle("on", micOn);
  micToggle.setAttribute("aria-pressed", String(micOn));
  micState.textContent = micOn ? "on" : "off";
  micToggle.title = micOn
    ? "Mic is on — click or press Space to mute"
    : "Mic is off — click or press Space to listen";
  micLevel.classList.toggle("muted", !micOn || (player.isPlaying && !player.aecActive));
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
    bargePending = false;
    bargeCommitted = false;
    bargeBuffer = [];
    player.unduck();
    if (endpointer.cancel() && utteranceActive) wire.send({ type: "mic.cancel" });
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
ssStop.addEventListener("click", interruptPerformance);

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

// ── quiet toggle UI (also driven by session.replay adoption) ─
function setQuietUI(q: boolean): void {
  quiet = q;
  const voiceOn = !quiet;
  quietToggle.classList.toggle("on", voiceOn);
  quietToggle.setAttribute("aria-pressed", String(voiceOn));
  quietState.textContent = voiceOn ? "on" : "off";
  quietIcon.textContent = voiceOn ? "🔊" : "🔇";
  quietToggle.title = voiceOn
    ? "Voice on — click for captions only"
    : "Captions only — click to hear Jarvis speak";
}

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
        return;
      case "turn.end":
        if (currentTurnId === msg.turnId) currentTurnId = null;
        currentJarvisLine?.classList.remove("speaking");
        currentJarvisLine = null;
        thoughtLines.delete(msg.turnId); // line stays in the rail as history
        return;
      case "heard":
        transcript.addLine("user", msg.text);
        return;
      case "thought": {
        // inner monologue: one dim line per turn in conversation, updated in
        // place (the activity tab renders its own typed row off the event log)
        let line = thoughtLines.get(msg.turnId);
        if (!line) {
          line = transcript.addLine("thought", msg.text);
          thoughtLines.set(msg.turnId, line);
        } else {
          line.textContent = msg.text;
          transcript.scrollToEnd();
        }
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
        if (item.kind === "focus") {
          // Jarvis maximizes/zooms an exhibit; "none" closes.
          if (item.ref === "none") return lightbox.closeIfAny();
          const card = exhibits.resolveCard(item.turnId, item.ref);
          if (card) lightbox.open(card, item.zoom);
          else
            reportFault(
              "missing-target",
              `<focus ref="${item.ref}"/> matched no exhibit on the stage`,
              item.turnId,
            );
          return;
        }
        return;
      }
      case "audio.segment":
        audioMeta.set(msg.streamId, { turnId: msg.turnId });
        return;
      // the durable record, live: everything Jarvis and its subagents do
      case "activity":
        activity.event(msg.event);
        return;
      // Layer 2 replay-on-connect: repaint boards + captions + activity so a
      // refreshed tab converges with the running session. Never carries audio.
      case "session.replay": {
        transcript.clear();
        thoughtLines.clear();
        currentJarvisLine = null;
        currentTurnId = null;
        lightbox.closeIfAny();
        exhibits.dismiss("", "all");
        for (const e of msg.activityTail) {
          if (e.kind === "heard") transcript.addLine("user", e.text);
          else if (e.kind === "say") transcript.addLine("jarvis", e.text);
          else if (e.kind === "note" && e.level === "warn") transcript.addLine("warn", e.text);
        }
        // re-show under the ORIGINAL turnId:id key — a refreshed tab and a
        // second tab converge instead of duplicating boards
        for (const ex of msg.exhibits) exhibits.show(ex.turnId, ex.id, ex.exhibit);
        activity.reset(msg.activityTail, msg.sessionId);
        setQuietUI(msg.quiet);
        return;
      }
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
      case "barge": {
        // §6.2 stage-two verdict on a committed acoustic barge. "cut": real
        // words landed and the old performance was truncated — drop its audio.
        // "resume": it was noise, so un-duck and let Jarvis carry on. Either way
        // the barge is resolved.
        if (msg.verdict === "cut") player.flush(); // flush() also un-ducks
        else player.unduck();
        bargePending = false;
        bargeCommitted = false;
        bargeBuffer = [];
        bargeBufferedMs = 0;
        return;
      }
      case "session.reset":
        clearRoom();
        toasts.show("Started a new conversation.", "info");
        return;
      case "settings":
        settings.populate(msg.settings);
        statusStrip.setSettings(msg.settings);
        wakeEnabled = msg.settings.wake_enabled;
        wakeWord = msg.settings.wake_word;
        wakeUi();
        if (msg.note) toasts.show(msg.note, "info");
        return;
      case "error":
        transcript.addLine("warn", msg.message);
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
  setQuietUI(!quiet);
  wire.send({ type: "quiet.set", quiet });
});

// ── wake toggle: gate on = presence mode (idle speech needs "jarvis…"),
// gate off = always listening. Server-owned setting; the button just flips it
// and the settings echo updates every tab.
const wakeToggle = $<HTMLButtonElement>("#wakeToggle");
const wakeState = $("#wakeState");
let wakeEnabled = false;
let wakeWord = "jarvis";

function wakeUi(): void {
  wakeToggle.classList.toggle("on", wakeEnabled);
  wakeToggle.setAttribute("aria-pressed", String(wakeEnabled));
  wakeState.textContent = wakeEnabled ? "on" : "off";
  wakeToggle.title = wakeEnabled
    ? `Wake word on — idle speech needs "${wakeWord}…". Click to always listen.`
    : "Wake word off — Jarvis listens to everything. Click to require the wake word.";
}
wakeToggle.addEventListener("click", () => {
  wire.send({ type: "settings.set", patch: { wake_enabled: !wakeEnabled } });
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
