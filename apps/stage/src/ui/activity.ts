// The "activity" tab: a timestamped operational log of what Jarvis is doing,
// distinct from the clean conversation view. Turn boundaries are dividers; the
// inner monologue (thought) streams as one evolving entry per turn (the wire
// sends cumulative tail text, so appending each delta would just staircase);
// real tool calls (act items) land as their own marker entries.
export class Activity {
  private turnEntry = new Map<string, HTMLElement>();

  constructor(
    private readonly root: HTMLElement, // #activity (scroll list)
    private readonly pane: HTMLElement, // conversation/activity pane — toggles empty state
    private readonly onAppend?: () => void, // e.g. badge the tab when hidden
  ) {}

  turnStart(source: string): void {
    const div = document.createElement("div");
    div.className = "ae-div";
    div.innerHTML = `<span class="ae-time">${stamp()}</span><span class="ae-div-label">turn · ${escapeText(source)}</span>`;
    this.append(div);
  }

  thought(turnId: string, text: string): void {
    let entry = this.turnEntry.get(turnId);
    if (!entry) {
      entry = this.entry("thought", "◇", text);
      this.turnEntry.set(turnId, entry);
    } else {
      const t = entry.querySelector<HTMLElement>(".ae-text");
      if (t) t.textContent = text;
      this.scroll();
    }
    this.onAppend?.();
  }

  tool(tool: string, risk: string): void {
    this.append(this.entry("tool", "⚙", `${tool} · ${risk}`));
    this.onAppend?.();
  }

  note(kind: "warn", text: string): void {
    this.append(this.entry(kind, "!", text));
    this.onAppend?.();
  }

  turnEnd(turnId: string): void {
    this.turnEntry.delete(turnId);
  }

  clear(): void {
    this.root.replaceChildren();
    this.turnEntry.clear();
    this.sync();
  }

  private entry(kind: string, icon: string, text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = `ae ae-${kind}`;
    el.innerHTML =
      `<span class="ae-time">${stamp()}</span>` +
      `<span class="ae-icon">${icon}</span>` +
      `<span class="ae-text"></span>`;
    el.querySelector<HTMLElement>(".ae-text")!.textContent = text;
    return el;
  }

  private append(el: HTMLElement): void {
    this.root.appendChild(el);
    while (this.root.children.length > 300) this.root.firstChild?.remove();
    this.scroll();
    this.sync();
  }

  private scroll(): void {
    this.root.scrollTop = this.root.scrollHeight;
  }

  private sync(): void {
    this.pane.classList.toggle("has-content", this.root.children.length > 0);
  }
}

function stamp(): string {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
}
