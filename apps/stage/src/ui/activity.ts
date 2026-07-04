import type { ActivityEvent } from "@jarvis/protocol";
import { $ } from "../dom.js";

// The activity tab, rebuilt on ActivityEvents (design §II.4): a turn-grouped,
// collapsible timeline that is scanned and OPERATED, not read. Typed rows —
// spoken / thinking / tool (upserted in place by callId as running→ok/error) /
// exhibit / note — nest under their turn card; a subagent is a nested violet
// card with its own timeline and live message/stop controls. Persisted and
// reloaded: the panel backfills from the session's event tail on connect, and
// a session picker opens older sessions read-only.

export interface ActivityHost {
  onSubagentSend: (id: string, message: string) => void;
  onSubagentStop: (id: string) => void;
  onUnread?: () => void;
}

interface TurnCard {
  el: HTMLElement;
  body: HTMLElement;
  title: HTMLElement;
  dot: HTMLElement;
  dur: HTMLElement;
  beganAt: number;
}

interface SubCard {
  el: HTMLElement;
  body: HTMLElement;
  state: HTMLElement;
  controls: HTMLElement;
}

export class Activity {
  private root: HTMLElement; // #activity (scroll list)
  private jump: HTMLElement;
  private sessionSel: HTMLSelectElement;

  private liveMode = true;
  private liveSession = "";
  private lastId = 0;

  private turnCards = new Map<string, TurnCard>();
  private subCards = new Map<string, SubCard>();
  private toolRows = new Map<string, HTMLElement>(); // `${agent}:${callId}` → row
  private thinkRows = new Map<string, HTMLElement>(); // `${agent}:${turn}` → row

  constructor(
    private readonly pane: HTMLElement, // #activityPane
    private readonly host: ActivityHost,
  ) {
    this.root = $("#activity", pane);
    this.jump = $("#actJump", pane);

    // filter chips — pure CSS switching via data-filter on the list
    for (const chip of pane.querySelectorAll<HTMLButtonElement>(".act-chips .chip")) {
      chip.addEventListener("click", () => {
        pane.querySelectorAll(".act-chips .chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        this.root.dataset.filter = chip.dataset.f ?? "all";
      });
    }

    // the side panel is narrow; a dense nested timeline earns width on demand
    $<HTMLButtonElement>("#actWide", pane).addEventListener("click", () => {
      document.querySelector("#workspace")?.classList.toggle("act-wide");
    });

    // session picker: live by default; older sessions open read-only
    this.sessionSel = $<HTMLSelectElement>("#actSession", pane);
    this.sessionSel.addEventListener("focus", () => void this.refreshSessionList());
    this.sessionSel.addEventListener("change", () => {
      const v = this.sessionSel.value;
      void this.loadSession(v === "live" ? null : v);
    });

    this.jump.addEventListener("click", () => {
      this.scrollToEnd();
      this.jump.classList.add("hidden");
    });
    this.root.addEventListener("scroll", () => {
      if (this.nearBottom()) this.jump.classList.add("hidden");
    });
  }

  // ── feed ─────────────────────────────────────────────────────
  // One live event off the wire. Ignored while browsing an old session; deduped
  // against the replay tail (a resolving tool event still upserts — it arrives
  // with a fresh id but the same callId).
  event(e: ActivityEvent): void {
    if (!this.liveMode) return;
    if (e.session === this.liveSession && e.id <= this.lastId) return;
    if (e.session !== this.liveSession) {
      this.liveSession = e.session;
      this.lastId = 0;
    }
    this.lastId = e.id;
    this.render(e);
    this.host.onUnread?.();
  }

  // Backfill from the reconnect replay (Layer 2): rebuild to match the session.
  reset(events: ActivityEvent[], sessionId: string): void {
    this.clear();
    this.liveMode = true;
    this.liveSession = sessionId;
    this.lastId = events.length ? events[events.length - 1]!.id : 0;
    for (const e of events) this.render(e);
    this.scrollToEnd();
    this.sessionSel.value = "live";
  }

  clear(): void {
    this.root.replaceChildren();
    this.turnCards.clear();
    this.subCards.clear();
    this.toolRows.clear();
    this.thinkRows.clear();
    this.sync();
  }

  // ── session picker ───────────────────────────────────────────
  private async refreshSessionList(): Promise<void> {
    try {
      const res = await fetch("/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const sessions = (await res.json()) as Array<{ id: string; live: boolean }>;
      const current = this.sessionSel.value;
      this.sessionSel.replaceChildren(
        option("live", "● live"),
        ...sessions.filter((s) => !s.live).map((s) => option(s.id, sessionLabel(s.id))),
      );
      this.sessionSel.value = [...this.sessionSel.options].some((o) => o.value === current)
        ? current
        : "live";
    } catch {
      /* picker is best-effort */
    }
  }

  private async loadSession(id: string | null): Promise<void> {
    try {
      const res = await fetch(id ? `/activity?session=${encodeURIComponent(id)}` : "/activity", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const events = (await res.json()) as ActivityEvent[];
      this.clear();
      if (id) {
        // read-only view of a closed session
        this.liveMode = false;
        this.pane.classList.add("viewing-past");
        for (const e of events) this.render(e);
        this.scrollToEnd();
      } else {
        this.pane.classList.remove("viewing-past");
        this.reset(events, events.length ? events[events.length - 1]!.session : this.liveSession);
      }
    } catch {
      this.note("error", "couldn't load that session");
    }
  }

  // ── rendering ────────────────────────────────────────────────
  private render(e: ActivityEvent): void {
    switch (e.kind) {
      case "session":
        this.divider(`session ${e.phase}${e.reason ? ` · ${e.reason}` : ""}`, e.at);
        return;
      case "turn":
        if (e.agent !== "main" || !e.turn) return;
        if (e.phase === "begin") this.beginTurn(e.turn, e.source ?? "text", e.at);
        else this.endTurn(e.turn, e.status ?? "ok", e.at);
        return;
      case "heard": {
        const card = e.turn ? this.ensureTurn(e.turn, "voice", e.at) : null;
        if (card) card.title.textContent = e.text;
        return;
      }
      case "say":
        this.appendRow(e, this.sayRow(e.text));
        return;
      case "think":
        this.upsertThink(e);
        return;
      case "tool":
        this.upsertTool(e);
        return;
      case "exhibit":
        this.appendRow(
          e,
          this.row("exhibit", "⧉", `${e.op} · ${e.title ?? e.ref ?? e.exhibitId}`),
        );
        return;
      case "subagent":
        this.subagentEvent(e);
        return;
      case "note": {
        const row = this.row("note", e.level === "info" ? "·" : "!", e.text);
        if (e.level !== "info") row.classList.add("is-error");
        row.classList.add(`nl-${e.level}`);
        this.appendRow(e, row);
        return;
      }
    }
  }

  // Where does this event's row live? A subagent's rows nest in its card; main
  // rows nest in their turn card; anything else lands at the top level.
  private containerFor(e: ActivityEvent): HTMLElement {
    if (e.agent !== "main") return this.ensureSub(e.agent, e.parent).body;
    if (e.turn) {
      const card = this.turnCards.get(e.turn);
      if (card) return card.body;
    }
    return this.root;
  }

  private appendRow(e: ActivityEvent, row: HTMLElement): void {
    this.containerFor(e).appendChild(row);
    this.afterAppend();
  }

  private beginTurn(turnId: string, source: string, at: string): void {
    this.ensureTurn(turnId, source, at);
  }

  private ensureTurn(turnId: string, source: string, at: string): TurnCard {
    const existing = this.turnCards.get(turnId);
    if (existing) return existing;
    const el = document.createElement("div");
    el.className = "turn running";
    el.dataset.turn = turnId;
    const chip = source === "voice" ? "🎙" : source === "system" ? "◍" : "⌨";
    el.innerHTML =
      `<header class="turn-head">` +
      `<span class="turn-chip">${chip}</span>` +
      `<span class="turn-title">${source === "system" ? "background report" : "…"}</span>` +
      `<span class="turn-time">${stamp(at)}</span>` +
      `<span class="turn-dur"></span>` +
      `<span class="turn-dot"></span>` +
      `</header><div class="turn-body"></div>`;
    el.querySelector(".turn-head")!.addEventListener("click", () => el.classList.toggle("collapsed"));
    const card: TurnCard = {
      el,
      body: el.querySelector(".turn-body")!,
      title: el.querySelector(".turn-title")!,
      dot: el.querySelector(".turn-dot")!,
      dur: el.querySelector(".turn-dur")!,
      beganAt: Date.parse(at) || Date.now(),
    };
    this.turnCards.set(turnId, card);
    this.root.appendChild(el);
    this.afterAppend();
    return card;
  }

  private endTurn(turnId: string, status: string, at: string): void {
    const card = this.turnCards.get(turnId);
    if (!card) return;
    card.el.classList.remove("running");
    card.el.classList.add(`st-${status}`);
    const ms = (Date.parse(at) || Date.now()) - card.beganAt;
    card.dur.textContent = fmtMs(ms);
    card.dot.title = status;
  }

  // ── typed rows ───────────────────────────────────────────────
  private row(kind: string, icon: string, text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = `ar ar-${kind}`;
    el.innerHTML =
      `<div class="ar-line"><span class="ar-icon"></span><span class="ar-text"></span></div>`;
    el.querySelector<HTMLElement>(".ar-icon")!.textContent = icon;
    el.querySelector<HTMLElement>(".ar-text")!.textContent = text;
    return el;
  }

  private sayRow(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "ar ar-say";
    el.innerHTML = `<div class="ar-line"><span class="ar-rail"></span><span class="ar-text"></span></div>`;
    el.querySelector<HTMLElement>(".ar-text")!.textContent = text;
    return el;
  }

  // one evolving thought row per (agent, turn) — the wire carries tail
  // snapshots, so we replace, never append
  private upsertThink(e: Extract<ActivityEvent, { kind: "think" }>): void {
    const key = `${e.agent}:${e.turn ?? "top"}`;
    let row = this.thinkRows.get(key);
    if (!row) {
      row = this.row("think", "◇", e.text);
      row.addEventListener("click", () => row!.classList.toggle("open"));
      this.thinkRows.set(key, row);
      this.appendRow(e, row);
      return;
    }
    row.querySelector<HTMLElement>(".ar-text")!.textContent = e.text;
    this.maybeScroll();
  }

  // ONE row per tool call, animating running… → ok · 40ms in place
  private upsertTool(e: Extract<ActivityEvent, { kind: "tool" }>): void {
    const key = `${e.agent}:${e.callId}`;
    let row = this.toolRows.get(key);
    if (!row) {
      row = document.createElement("div");
      row.className = "ar ar-tool";
      row.innerHTML =
        `<div class="ar-line">` +
        `<span class="ar-icon"></span>` +
        `<span class="ar-name"></span>` +
        `<span class="ar-sum"></span>` +
        `<span class="ar-chip"></span>` +
        `</div>` +
        `<div class="ar-detail hidden"></div>`;
      row.querySelector(".ar-line")!.addEventListener("click", () => {
        row!.querySelector(".ar-detail")!.classList.toggle("hidden");
      });
      this.toolRows.set(key, row);
      this.appendRow(e, row);
    }
    row.querySelector<HTMLElement>(".ar-icon")!.textContent = toolIcon(e.name);
    row.querySelector<HTMLElement>(".ar-name")!.textContent = e.name;
    row.querySelector<HTMLElement>(".ar-sum")!.textContent = summarizeInput(e.input);
    const chip = row.querySelector<HTMLElement>(".ar-chip")!;
    if (e.status === "running") {
      chip.textContent = "running…";
      chip.className = "ar-chip st-running";
    } else if (e.status === "ok") {
      chip.textContent = e.durationMs !== undefined ? `ok · ${fmtMs(e.durationMs)}` : "ok";
      chip.className = "ar-chip st-ok";
    } else {
      chip.textContent = "error";
      chip.className = "ar-chip st-err";
      row.classList.add("is-error");
    }
    // full input and output expand in place
    const detail = row.querySelector<HTMLElement>(".ar-detail")!;
    detail.replaceChildren();
    if (e.input) {
      detail.appendChild(dlabel("input"));
      detail.appendChild(pre(e.input));
    }
    if (e.output !== undefined) {
      detail.appendChild(dlabel(`output${e.durationMs !== undefined ? ` · ${fmtMs(e.durationMs)}` : ""}`));
      detail.appendChild(pre(e.output || "(empty)"));
    }
    this.maybeScroll();
  }

  // ── subagent cards (§II.4/§II.5): another mind gets its own violet card ──
  private subagentEvent(e: Extract<ActivityEvent, { kind: "subagent" }>): void {
    const card = this.ensureSub(e.subId, e.parent, e.label, e.model);
    if (e.state) {
      card.state.textContent = e.state;
      card.el.dataset.state = e.state;
      const dead = e.state === "closed" || e.state === "failed" || e.state === "timed-out";
      card.controls.classList.toggle("hidden", dead);
    }
    if (e.op === "start" || e.op === "instruct") {
      if (e.instruction) card.body.appendChild(this.row("instruct", "»", e.instruction));
    } else if (e.op === "done" || e.op === "error") {
      const row = this.row("report", e.op === "error" ? "!" : "✓", e.summary ?? "(no report)");
      if (e.op === "error") row.classList.add("is-error");
      card.body.appendChild(row);
    } else if (e.op === "closed" && e.summary) {
      card.body.appendChild(this.row("report", "◌", e.summary));
    }
    this.afterAppend();
  }

  private ensureSub(subId: string, parentTurn?: string, label?: string, model?: string): SubCard {
    const existing = this.subCards.get(subId);
    if (existing) return existing;
    const el = document.createElement("div");
    el.className = "sub";
    el.dataset.sub = subId;
    el.innerHTML =
      `<header class="sub-head">` +
      `<span class="sub-glyph">⤳</span>` +
      `<span class="sub-label"></span>` +
      `<span class="sub-id"></span>` +
      `<span class="sub-model"></span>` +
      `<span class="sub-state">starting</span>` +
      `</header>` +
      `<div class="sub-body"></div>` +
      `<div class="sub-controls">` +
      `<input class="sub-msg" type="text" placeholder="message this subagent…" spellcheck="false"/>` +
      `<button class="sub-send" type="button" title="Send">↩</button>` +
      `<button class="sub-stop" type="button" title="Stop this subagent">Stop</button>` +
      `</div>`;
    el.querySelector<HTMLElement>(".sub-label")!.textContent = label ?? subId;
    el.querySelector<HTMLElement>(".sub-id")!.textContent = subId;
    el.querySelector<HTMLElement>(".sub-model")!.textContent = model ?? "";
    el.querySelector(".sub-head")!.addEventListener("click", () => el.classList.toggle("collapsed"));

    const input = el.querySelector<HTMLInputElement>(".sub-msg")!;
    const send = (): void => {
      const message = input.value.trim();
      if (!message) return;
      this.host.onSubagentSend(subId, message);
      input.value = "";
    };
    el.querySelector(".sub-send")!.addEventListener("click", send);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") send();
      ev.stopPropagation(); // Space must type, not toggle the mic
    });
    el.querySelector(".sub-stop")!.addEventListener("click", () => this.host.onSubagentStop(subId));

    const card: SubCard = {
      el,
      body: el.querySelector(".sub-body")!,
      state: el.querySelector(".sub-state")!,
      controls: el.querySelector(".sub-controls")!,
    };
    this.subCards.set(subId, card);

    // nest inside the tier-1 turn that spawned it; top-level when turnless
    // (ambient drafts, or a start event that fell outside the replay tail)
    const parent = parentTurn ? this.turnCards.get(parentTurn) : undefined;
    (parent ? parent.body : this.root).appendChild(el);
    parent?.el.classList.add("has-sub");
    return card;
  }

  private divider(label: string, at: string): void {
    const div = document.createElement("div");
    div.className = "ae-div";
    div.innerHTML = `<span class="ae-time"></span><span class="ae-div-label"></span>`;
    div.querySelector<HTMLElement>(".ae-time")!.textContent = stamp(at);
    div.querySelector<HTMLElement>(".ae-div-label")!.textContent = label;
    this.root.appendChild(div);
    this.afterAppend();
  }

  note(level: "warn" | "error", text: string): void {
    const row = this.row("note", "!", text);
    row.classList.add("is-error", `nl-${level}`);
    this.root.appendChild(row);
    this.afterAppend();
  }

  // ── scroll & chrome ──────────────────────────────────────────
  private afterAppend(): void {
    this.maybeScroll();
    this.sync();
  }

  private nearBottom(): boolean {
    return this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < 80;
  }

  private maybeScroll(): void {
    if (this.nearBottom()) this.scrollToEnd();
    else this.jump.classList.remove("hidden");
  }

  private scrollToEnd(): void {
    this.root.scrollTop = this.root.scrollHeight;
  }

  private sync(): void {
    this.pane.classList.toggle("has-content", this.root.children.length > 0);
  }
}

// ── helpers ────────────────────────────────────────────────────
function stamp(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour12: false });
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m${s}s` : `${m}m`;
}

function toolIcon(name: string): string {
  if (name === "Bash" || name === "terminal_run") return "⌘";
  if (/^wiki_(propose_edit|commit)/.test(name)) return "📝";
  if (/^wiki_/.test(name)) return "📖";
  if (/^(WebSearch|WebFetch)$/.test(name)) return "🌐";
  if (/^browser_/.test(name)) return "🖥";
  if (/^(subagent_|dispatch_background)/.test(name)) return "⤴";
  if (/^(Read|Grep|Glob)$/.test(name)) return "📄";
  if (/^settings_/.test(name)) return "⚙";
  return "⚙";
}

// one-line input summary for the collapsed row: the first interesting value
function summarizeInput(input?: string): string {
  if (!input) return "";
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      for (const v of Object.values(parsed)) {
        if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").slice(0, 80);
      }
      return "";
    }
  } catch {
    /* not JSON — raw */
  }
  return input.replace(/\s+/g, " ").slice(0, 80);
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

// "2026-07-03T14-22-05-3f2a" → "07-03 14:22"
function sessionLabel(id: string): string {
  const m = id.match(/^\d{4}-(\d{2}-\d{2})T(\d{2})-(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : id;
}

function dlabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "ar-dlabel";
  el.textContent = text;
  return el;
}

function pre(text: string): HTMLElement {
  const el = document.createElement("pre");
  el.className = "ar-pre";
  el.textContent = text;
  return el;
}
