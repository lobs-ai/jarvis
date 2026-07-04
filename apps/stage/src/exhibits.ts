import type { Exhibit } from "@jarvis/protocol";
import { renderMarkdown, renderCode, escapeHtml } from "./render.js";

// Exhibit manager: conjure / update / sweep. Ids are namespaced by turn so a
// model reusing "e1" across turns can't collide.
export class Exhibits {
  private byKey = new Map<string, HTMLElement>();

  constructor(
    private readonly root: HTMLElement,
    // maximize a card into the lightbox; close the lightbox if a focused card is
    // about to be replaced/swept away (so it lands back in the grid, not the overlay)
    private readonly onMaximize?: (card: HTMLElement) => void,
    private readonly onEvict?: (card: HTMLElement) => void,
    // something the model asked for didn't land on screen — feeds the
    // stage-fault loop so the model can repair its own show
    private readonly onFault?: (
      kind: "exhibit-unresolved" | "missing-target",
      detail: string,
      turnId: string,
    ) => void,
  ) {}

  show(turnId: string, id: string, exhibit: Exhibit): void {
    const key = `${turnId}:${id}`;
    const existing = this.byKey.get(key);
    if (existing) {
      this.onEvict?.(existing);
      existing.remove();
    }

    const card = document.createElement("div");
    card.className = "exhibit";
    card.dataset.key = key;
    card.dataset.plainId = id;

    const header = document.createElement("header");
    header.innerHTML =
      `<span class="etitle">${escapeHtml(exhibit.title ?? id)}</span>` +
      `<span class="hmeta"><span class="etype">${escapeHtml(exhibit.type)}</span>` +
      `<button class="close" type="button" title="Dismiss">✕</button></span>`;
    // Local dismiss (same sweep path); there is no client→server dismiss message.
    header.querySelector(".close")!.addEventListener("click", () => this.dismiss(turnId, id));
    const body = document.createElement("div");
    body.className = "body";
    // Click the exhibit itself to maximize it into the lightbox — no button needed.
    // (Ignored while already maximized so panning/zooming in the lightbox doesn't refit.)
    body.addEventListener("click", () => {
      if (!card.classList.contains("in-lightbox")) this.onMaximize?.(card);
    });
    this.render(body, exhibit, turnId);

    card.append(header, body);
    this.root.appendChild(card);
    this.byKey.set(key, card);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  update(turnId: string, ref: string, bodyText: string): void {
    const card = this.find(turnId, ref);
    if (!card) {
      this.onFault?.("missing-target", `<update ref="${ref}"/> matched no exhibit on the stage`, turnId);
      return;
    }
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
    } else {
      this.onFault?.("missing-target", `<dismiss ref="${ref}"/> matched no exhibit on the stage`, turnId);
    }
  }

  // Public resolver for the lightbox (focus items name an exhibit by ref).
  resolveCard(turnId: string, ref: string): HTMLElement | undefined {
    return this.find(turnId, ref);
  }

  private find(turnId: string, ref: string): HTMLElement | undefined {
    return (
      this.byKey.get(`${turnId}:${ref}`) ??
      // directives may reference an exhibit from an earlier turn
      [...this.byKey.values()].reverse().find((c) => c.dataset.plainId === ref)
    );
  }

  private sweep(card: HTMLElement): void {
    // If this card is focused in the lightbox, get it back into the grid first
    // so it sweeps out where it lives, not inside the overlay.
    this.onEvict?.(card);
    card.classList.add("dismissing");
    card.addEventListener("animationend", () => card.remove(), { once: true });
  }

  private render(body: HTMLElement, exhibit: Exhibit, turnId?: string): void {
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
        .catch((err: unknown) => {
          this.placeholder(body, exhibit.ref);
          if (turnId) {
            this.onFault?.(
              "exhibit-unresolved",
              `exhibit "${exhibit.title ?? "untitled"}" ref ${exhibit.ref} failed to render: ${String(err).slice(0, 160)}`,
              turnId,
            );
          }
        });
      return;
    }
    switch (exhibit.type) {
      case "markdown":
      case "code":
      case "diff": {
        if (content)
          this.renderContent(body, exhibit.type, content, "lang" in exhibit ? exhibit.lang : undefined);
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

  private renderContent(
    body: HTMLElement,
    type: "markdown" | "code" | "diff",
    text: string,
    lang?: string,
  ): void {
    if (type === "markdown") renderMarkdown(body, text);
    else if (type === "diff") body.innerHTML = renderDiff(text);
    else renderCode(body, text, lang);
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
