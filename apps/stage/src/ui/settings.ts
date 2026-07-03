import type { SettingsPatch, SettingsSnapshot } from "@jarvis/protocol";
import { $ } from "../dom.js";
import { MODEL_OPTIONS, THINKING_OPTIONS, type Option } from "../models.js";

// The slide-in settings drawer. Owns open/close, dirty tracking (Apply is
// disabled until a field differs from the last server snapshot), and building
// a patch with ONLY changed fields. The daemon is the single writer — this just
// proposes changes and re-syncs when the server echoes the new snapshot back.
export interface SettingsHost {
  onApply: (patch: SettingsPatch) => void;
}

export class Settings {
  private drawer = $("#settingsDrawer");
  private scrim = $("#settingsScrim");
  private toggleBtn = $<HTMLButtonElement>("#settingsToggle");
  private closeBtn = $<HTMLButtonElement>("#settingsClose");
  private model = $<HTMLSelectElement>("#setModel");
  private thinking = $<HTMLSelectElement>("#setThinking");
  private wiki = $<HTMLInputElement>("#setWiki");
  private apply = $<HTMLButtonElement>("#setApply");
  private snapshot: SettingsSnapshot | null = null;

  constructor(private readonly host: SettingsHost) {
    fillOptions(this.model, MODEL_OPTIONS);
    fillOptions(this.thinking, THINKING_OPTIONS);
    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.closeBtn.addEventListener("click", () => this.close());
    this.scrim.addEventListener("click", () => this.close());
    for (const el of [this.model, this.thinking, this.wiki]) {
      el.addEventListener("input", () => this.refreshDirty());
      el.addEventListener("change", () => this.refreshDirty());
    }
    this.apply.addEventListener("click", () => this.applyChanges());
  }

  get isOpen(): boolean {
    return this.drawer.classList.contains("open");
  }

  // Fills the controls from the authoritative server snapshot. A model outside
  // the preset list (config-file edits, future models) is injected as an option
  // so it can still be shown and re-selected.
  populate(s: SettingsSnapshot): void {
    this.snapshot = s;
    if (![...this.model.options].some((o) => o.value === s.model_tier1)) {
      const opt = document.createElement("option");
      opt.value = s.model_tier1;
      opt.textContent = s.model_tier1;
      this.model.appendChild(opt);
    }
    this.model.value = s.model_tier1;
    this.thinking.value = s.thinking;
    this.wiki.value = s.wiki_dir;
    this.refreshDirty();
  }

  open(): void {
    this.drawer.classList.add("open");
    this.scrim.classList.add("open");
    this.drawer.setAttribute("aria-hidden", "false");
    this.toggleBtn.setAttribute("aria-expanded", "true");
    this.refreshDirty();
    this.model.focus();
  }

  close(): void {
    this.drawer.classList.remove("open");
    this.scrim.classList.remove("open");
    this.drawer.setAttribute("aria-hidden", "true");
    this.toggleBtn.setAttribute("aria-expanded", "false");
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private buildPatch(): SettingsPatch {
    const s = this.snapshot;
    const patch: SettingsPatch = {};
    if (!s) return patch;
    if (this.model.value !== s.model_tier1) patch.model_tier1 = this.model.value;
    if (this.thinking.value !== s.thinking)
      patch.thinking = this.thinking.value as SettingsPatch["thinking"];
    const wiki = this.wiki.value.trim();
    if (wiki && wiki !== s.wiki_dir) patch.wiki_dir = wiki;
    return patch;
  }

  private refreshDirty(): void {
    this.apply.disabled = Object.keys(this.buildPatch()).length === 0;
  }

  private applyChanges(): void {
    const patch = this.buildPatch();
    if (Object.keys(patch).length > 0) this.host.onApply(patch);
    this.close();
  }
}

function fillOptions(sel: HTMLSelectElement, options: Option[]): void {
  sel.replaceChildren(
    ...options.map((o) => {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      return opt;
    }),
  );
}
