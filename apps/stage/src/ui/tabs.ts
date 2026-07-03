// The right column's tab bar. Buttons live in the panel header; panes live in
// the panel body. Exactly one pane is visible; the rest carry `.hidden`. A tab
// can also show an unread badge (a dot) when its pane gets activity while it's
// not the one on screen.
export class Tabs {
  private buttons: HTMLButtonElement[];
  private panes = new Map<string, HTMLElement>();
  private current = "";

  constructor(
    tablist: HTMLElement,
    body: HTMLElement,
    private readonly onShow?: (name: string) => void,
  ) {
    this.buttons = [...tablist.querySelectorAll<HTMLButtonElement>(".tab")];
    for (const p of body.querySelectorAll<HTMLElement>(".tabpane")) {
      this.panes.set(p.dataset.pane ?? "", p);
    }
    for (const b of this.buttons) b.addEventListener("click", () => this.show(b.dataset.tab ?? ""));
    this.show(this.buttons[0]?.dataset.tab ?? "");
  }

  get active(): string {
    return this.current;
  }

  show(name: string): void {
    if (!this.panes.has(name)) return;
    this.current = name;
    for (const b of this.buttons) {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      if (on) b.classList.remove("has-badge");
    }
    for (const [key, pane] of this.panes) pane.classList.toggle("hidden", key !== name);
    this.onShow?.(name);
  }

  // Flag unread activity on a tab; ignored (and immediately cleared) if it's the
  // tab currently on screen.
  badge(name: string): void {
    if (name === this.current) return;
    this.buttons.find((b) => b.dataset.tab === name)?.classList.add("has-badge");
  }
}
