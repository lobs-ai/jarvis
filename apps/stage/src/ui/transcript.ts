// The conversation view. Owns line append/scroll, the 200-line cap, and toggling
// the empty-state hint on its pane. Turn-scoped bookkeeping — which line is
// "speaking", the per-turn thought line — stays in main.ts; this is just the
// surface it writes to.
export class Transcript {
  constructor(
    private readonly list: HTMLElement, // #transcript
    private readonly pane: HTMLElement, // conversation pane — toggles empty state
  ) {}

  addLine(cls: string, text: string): HTMLElement {
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.textContent = text;
    this.list.appendChild(div);
    this.list.scrollTop = this.list.scrollHeight;
    while (this.list.children.length > 200) this.list.firstChild?.remove();
    this.sync();
    return div;
  }

  scrollToEnd(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }

  clear(): void {
    this.list.replaceChildren();
    this.sync();
  }

  private sync(): void {
    this.pane.classList.toggle("has-content", this.list.children.length > 0);
  }
}
