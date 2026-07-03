import { $ } from "../dom.js";

// The "wiki" tab: an index over the wiki. It lists pages and searches them via
// thin jarvisd text endpoints, and clicking any page/result opens it as a
// markdown exhibit ON THE STAGE (the tab is the index; the stage is where
// content lands). Degrades to a placeholder if the endpoints 404 (they're built
// concurrently and may not exist during a dev loop).
export class Wiki {
  private search = $<HTMLInputElement>(".wiki-search");
  private status = $(".wiki-status");
  private results = $(".wiki-results");
  private pagesEl = $(".wiki-pages");
  private pagesLabel = $(".wiki-pages-label");
  private loaded = false;
  private timer: number | null = null;

  constructor(
    private readonly onOpen: (path: string, title: string) => void,
  ) {
    this.search.addEventListener("input", () => this.onInput());
  }

  // Load the page inventory the first time the tab is opened (cheap laziness).
  ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    void this.loadPages();
  }

  private onInput(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.runSearch(), 220);
  }

  private async loadPages(): Promise<void> {
    let text: string;
    try {
      const res = await fetch("/wiki/pages");
      if (!res.ok) throw new Error(String(res.status));
      text = await res.text();
    } catch {
      this.unavailable();
      return;
    }
    if (text.trim() === "(empty wiki)") {
      this.pagesLabel.textContent = "Pages";
      this.pagesEl.replaceChildren(hint("The wiki has no pages yet."));
      return;
    }
    const paths = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".md"));
    this.pagesLabel.textContent = `Pages · ${paths.length}`;
    this.pagesEl.replaceChildren(...paths.map((p) => this.row(p)));
  }

  private async runSearch(): Promise<void> {
    const q = this.search.value.trim();
    if (!q) {
      this.results.replaceChildren();
      this.results.classList.add("hidden");
      this.pagesLabel.classList.remove("hidden");
      this.pagesEl.classList.remove("hidden");
      return;
    }
    this.pagesLabel.classList.add("hidden");
    this.pagesEl.classList.add("hidden");
    this.results.classList.remove("hidden");
    let text: string;
    try {
      const res = await fetch(`/wiki/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(String(res.status));
      text = await res.text();
    } catch {
      this.results.replaceChildren(hint("Search unavailable."));
      return;
    }
    if (text.trim() === "" || text.trim() === "no matches") {
      this.results.replaceChildren(hint(`No matches for “${q}”.`));
      return;
    }
    // lines of "path:line: matched text"
    const rows: HTMLElement[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const m = line.match(/^(.+?\.md):(\d+):\s?(.*)$/);
      if (m) rows.push(this.row(m[1]!, m[3], m[2]));
      else rows.push(hint(line));
    }
    this.results.replaceChildren(...rows);
  }

  // One clickable page/result row: prominent title, muted folder, optional
  // matched line number + snippet.
  private row(path: string, snippet?: string, lineNo?: string): HTMLElement {
    const title = base(path);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const el = document.createElement("button");
    el.type = "button";
    el.className = "wiki-row";
    el.innerHTML =
      `<span class="wr-title"></span>` +
      (dir ? `<span class="wr-dir"></span>` : "") +
      (lineNo ? `<span class="wr-line">:${escapeAttr(lineNo)}</span>` : "") +
      (snippet ? `<span class="wr-snippet"></span>` : "");
    el.querySelector<HTMLElement>(".wr-title")!.textContent = title;
    if (dir) el.querySelector<HTMLElement>(".wr-dir")!.textContent = dir;
    if (snippet) el.querySelector<HTMLElement>(".wr-snippet")!.textContent = snippet;
    el.addEventListener("click", () => this.onOpen(path, title));
    return el;
  }

  private unavailable(): void {
    this.status.textContent = "Wiki endpoints unavailable.";
    this.status.classList.remove("hidden");
    this.pagesLabel.classList.add("hidden");
  }
}

function base(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.md$/, "");
}

function hint(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "wiki-hint";
  el.textContent = text;
  return el;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
