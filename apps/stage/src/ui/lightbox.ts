import { $ } from "../dom.js";

// Full-stage overlay that maximizes a single exhibit for close inspection —
// driven by the user (click a card, wheel/drag/buttons here) and by Jarvis (focus
// items). It MOVES the live card node into the overlay (a placeholder holds its
// grid slot) rather than cloning it, so an <update> to a focused exhibit keeps
// rendering live. Zoom/pan is a CSS transform on a content wrapper; last input
// wins — a user gesture is never snapped back by Jarvis.
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

export class Lightbox {
  private root = $("#lightbox");
  private viewport = $("#lbViewport");
  private content = $("#lbContent");
  private titleEl = $("#lbTitle");
  private zoomLabel = $("#lbZoom");

  private card: HTMLElement | null = null;
  private placeholder: HTMLElement | null = null;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(private readonly onClose?: () => void) {
    $<HTMLButtonElement>("#lbClose").addEventListener("click", () => this.close());
    $<HTMLButtonElement>("#lbIn").addEventListener("click", () => this.centerZoom(1.25));
    $<HTMLButtonElement>("#lbOut").addEventListener("click", () => this.centerZoom(1 / 1.25));
    $<HTMLButtonElement>("#lbFit").addEventListener("click", () => this.reset(1));

    // click the backdrop (not the panel) to close
    this.root.addEventListener("click", (ev) => {
      if (ev.target === this.root) this.close();
    });

    this.viewport.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        this.zoomAt(ev.clientX, ev.clientY, this.scale * Math.exp(-ev.deltaY * 0.0015));
      },
      { passive: false },
    );
    this.viewport.addEventListener("dblclick", (ev) => {
      if (this.scale > 1.01) this.reset(1);
      else this.zoomAt(ev.clientX, ev.clientY, 2);
    });
    this.viewport.addEventListener("pointerdown", (ev) => {
      this.dragging = true;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      this.viewport.classList.add("grabbing");
      this.viewport.setPointerCapture(ev.pointerId);
    });
    this.viewport.addEventListener("pointermove", (ev) => {
      if (!this.dragging) return;
      this.tx += ev.clientX - this.lastX;
      this.ty += ev.clientY - this.lastY;
      this.lastX = ev.clientX;
      this.lastY = ev.clientY;
      this.apply();
    });
    const endDrag = (): void => {
      this.dragging = false;
      this.viewport.classList.remove("grabbing");
    };
    this.viewport.addEventListener("pointerup", endDrag);
    this.viewport.addEventListener("pointercancel", endDrag);
  }

  get isOpen(): boolean {
    return this.card !== null;
  }

  // Maximize `card`. If another card is focused, it is restored first. zoom (from
  // a Jarvis focus item) is fit-first then scaled; a user card-click passes none → fit.
  open(card: HTMLElement, zoom?: number): void {
    if (this.card !== card) {
      if (this.card) this.restore();
      const ph = document.createElement("div");
      ph.className = "exhibit-placeholder";
      card.before(ph); // ph holds the grid slot; card moves into the overlay
      this.placeholder = ph;
      card.classList.add("in-lightbox");
      this.content.replaceChildren(card);
      this.card = card;
    }
    this.titleEl.textContent = card.querySelector(".etitle")?.textContent ?? "exhibit";
    this.root.classList.add("open");
    this.reset(zoom ?? 1);
  }

  close(): void {
    if (!this.card) return;
    this.restore();
    this.root.classList.remove("open");
    this.onClose?.();
  }

  closeIfAny(): void {
    if (this.card) this.close();
  }

  // Close if `card` is the focused one — called before it's dismissed/evicted so
  // it lands back in the grid (not the overlay) to sweep out.
  closeIfShowing(card: HTMLElement | null): void {
    if (card && card === this.card) this.close();
  }

  private restore(): void {
    const card = this.card;
    const ph = this.placeholder;
    if (card && ph) {
      card.classList.remove("in-lightbox");
      ph.replaceWith(card); // card returns to its original slot/order
    } else if (card) {
      card.remove();
    }
    this.card = null;
    this.placeholder = null;
    this.content.replaceChildren();
  }

  private centerZoom(mult: number): void {
    const r = this.viewport.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, this.scale * mult);
  }

  // Zoom toward (cx, cy) in screen coords, keeping that point fixed.
  private zoomAt(cx: number, cy: number, next: number): void {
    const s2 = clamp(next);
    const rect = this.content.getBoundingClientRect();
    const dx = cx - (rect.left + rect.width / 2);
    const dy = cy - (rect.top + rect.height / 2);
    const k = 1 - s2 / this.scale;
    this.tx += dx * k;
    this.ty += dy * k;
    this.scale = s2;
    this.apply();
  }

  private reset(zoom: number): void {
    this.scale = clamp(zoom);
    this.tx = 0;
    this.ty = 0;
    this.apply();
  }

  private apply(): void {
    this.content.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
  }
}

function clamp(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}
