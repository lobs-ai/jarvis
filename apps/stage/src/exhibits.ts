import { marked } from "marked";
import type { Exhibit } from "@jarvis/protocol";

// Exhibit manager: conjure / update / sweep. Ids are namespaced by turn so a
// model reusing "e1" across turns can't collide.
export class Exhibits {
  private byKey = new Map<string, HTMLElement>();

  constructor(private readonly root: HTMLElement) {}

  show(turnId: string, id: string, exhibit: Exhibit): void {
    const key = `${turnId}:${id}`;
    this.byKey.get(key)?.remove();

    const card = document.createElement("div");
    card.className = "exhibit";
    card.dataset.key = key;
    card.dataset.plainId = id;

    const header = document.createElement("header");
    header.innerHTML = `<span>${escapeHtml(exhibit.title ?? id)}</span><span class="etype">${exhibit.type}</span>`;
    const body = document.createElement("div");
    body.className = "body";
    this.render(body, exhibit);

    card.append(header, body);
    this.root.appendChild(card);
    this.byKey.set(key, card);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  update(turnId: string, ref: string, bodyText: string): void {
    const card = this.find(turnId, ref);
    if (!card) return;
    const body = card.querySelector<HTMLElement>(".body");
    if (!body) return;
    const type = card.querySelector(".etype")?.textContent ?? "markdown";
    this.render(body, { type, body: bodyText } as Exhibit);
  }

  dismiss(turnId: string, ref: string): void {
    if (ref === "all") {
      for (const card of this.byKey.values()) this.sweep(card);
      this.byKey.clear();
      return;
    }
    const card = this.find(turnId, ref);
    if (card) {
      this.byKey.delete(card.dataset.key!);
      this.sweep(card);
    }
  }

  private find(turnId: string, ref: string): HTMLElement | undefined {
    return (
      this.byKey.get(`${turnId}:${ref}`) ??
      // directives may reference an exhibit from an earlier turn
      [...this.byKey.values()].reverse().find((c) => c.dataset.plainId === ref)
    );
  }

  private sweep(card: HTMLElement): void {
    card.classList.add("dismissing");
    card.addEventListener("animationend", () => card.remove(), { once: true });
  }

  private render(body: HTMLElement, exhibit: Exhibit): void {
    const content = "body" in exhibit ? exhibit.body : undefined;
    // by-reference exhibits resolve through jarvisd's /ref endpoint
    if (!content && exhibit.type !== "image" && exhibit.ref) {
      body.innerHTML = `<div class="placeholder">conjuring ${escapeHtml(exhibit.ref)}…</div>`;
      void fetch(`/ref?uri=${encodeURIComponent(exhibit.ref)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(await res.text());
          const text = await res.text();
          this.renderContent(body, exhibit.type, text);
        })
        .catch(() => this.placeholder(body, exhibit.ref));
      return;
    }
    switch (exhibit.type) {
      case "markdown":
      case "code":
      case "diff": {
        if (content) this.renderContent(body, exhibit.type, content);
        else this.placeholder(body, exhibit.ref);
        return;
      }
      case "image": {
        const src = exhibit.src;
        if (src) {
          const img = document.createElement("img");
          img.src = src;
          body.replaceChildren(img);
        } else this.placeholder(body, exhibit.ref);
        return;
      }
    }
  }

  private renderContent(body: HTMLElement, type: "markdown" | "code" | "diff", text: string): void {
    if (type === "markdown") body.innerHTML = marked.parse(text, { async: false }) as string;
    else if (type === "diff") body.innerHTML = renderDiff(text);
    else body.innerHTML = `<pre><code>${escapeHtml(text)}</code></pre>`;
  }

  // A well-formed ref that can't resolve yet renders a placeholder naming the
  // miss (design: distinct from malformed markup, never spoken).
  private placeholder(body: HTMLElement, ref?: string): void {
    body.innerHTML = `<div class="placeholder">couldn't resolve ${escapeHtml(ref ?? "content")}</div>`;
  }
}

function renderDiff(text: string): string {
  const lines = text.split("\n").map((line) => {
    const esc = escapeHtml(line);
    if (line.startsWith("+")) return `<span class="diff-add">${esc}</span>`;
    if (line.startsWith("-")) return `<span class="diff-del">${esc}</span>`;
    if (line.startsWith("@@")) return `<span class="diff-hunk">${esc}</span>`;
    return esc;
  });
  return `<pre><code>${lines.join("\n")}</code></pre>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
