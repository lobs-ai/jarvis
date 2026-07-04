import type { SettingsSnapshot } from "@jarvis/protocol";
import { $ } from "../dom.js";
import { modelLabel } from "../models.js";

// The thin always-visible strip under the top bar. Left side: the live model /
// thinking / wiki basename, sourced from the WS settings message. Right side:
// sidecar health from GET /status (polled), rendered as tiny ok/down dots.
export interface Health {
  stt: boolean;
  tts: boolean;
  brain: "cli" | "api";
  active: boolean;
  uptime_s: number;
}

export class StatusStrip {
  private model = $("#ssModel");
  private thinking = $("#ssThinking");
  private wiki = $("#ssWiki");
  private wake = $("#ssWake");
  private earsDot = $("#ssEars .hdot");
  private voiceDot = $("#ssVoice .hdot");
  private brainDot = $("#ssBrain .hdot");
  private brainKind = $("#ssBrainKind");
  private uptime = $("#ssUptime");

  setSettings(s: SettingsSnapshot): void {
    this.model.textContent = modelLabel(s.model_tier1);
    this.model.title = s.model_tier1;
    this.thinking.textContent = s.thinking;
    this.wiki.textContent = basename(s.wiki_dir);
    this.wiki.title = s.wiki_dir;
    // Layer 4 wake state: when the gate is on, an idle utterance becomes a
    // turn only if it starts with the word — surface that so a dropped turn is
    // never a mystery.
    const gated = s.wake_enabled && s.wake_word.length > 0;
    this.wake.textContent = gated ? `say “${s.wake_word}…”` : "off";
    this.wake.title = gated
      ? `Idle voice input needs the wake word "${s.wake_word}" (confirmations and barge-in don't)`
      : "Wake word off — every utterance becomes a turn";
  }

  // null → we couldn't reach /status (offline or endpoint missing): show unknown.
  setHealth(h: Health | null): void {
    if (!h) {
      dot(this.earsDot, "unknown");
      dot(this.voiceDot, "unknown");
      dot(this.brainDot, "unknown");
      this.brainKind.textContent = "brain";
      this.uptime.textContent = "";
      return;
    }
    dot(this.earsDot, h.stt ? "ok" : "down");
    dot(this.voiceDot, h.tts ? "ok" : "down");
    dot(this.brainDot, "ok");
    this.brainKind.textContent = h.brain;
    this.uptime.textContent = `up ${fmtUptime(h.uptime_s)}`;
  }
}

function dot(el: HTMLElement, state: "ok" | "down" | "unknown"): void {
  el.classList.remove("ok", "down", "unknown");
  el.classList.add(state);
}

function basename(dir: string): string {
  const parts = dir.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return "—";
  const last = parts[parts.length - 1]!;
  // a bare "wiki" says nothing — include the parent (personal-wiki/wiki)
  if (last === "wiki" && parts.length > 1) return `${parts[parts.length - 2]}/${last}`;
  return last;
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
