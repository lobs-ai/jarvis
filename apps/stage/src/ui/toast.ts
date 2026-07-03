// Transient bottom-right notifications: settings notes, errors, connection
// changes, new-conversation markers. Auto-dismiss on a timer; click to dismiss
// early. Purely presentational — callers decide when something is toast-worthy.

export type ToastKind = "info" | "success" | "error";

const ICON: Record<ToastKind, string> = { info: "◈", success: "✓", error: "!" };

export class Toasts {
  constructor(private readonly root: HTMLElement) {}

  show(text: string, kind: ToastKind = "info", ttlMs = 4200): void {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.textContent = ICON[kind];

    const body = document.createElement("span");
    body.className = "toast-body";
    body.textContent = text;

    el.append(icon, body);
    el.addEventListener("click", () => this.dismiss(el));
    this.root.appendChild(el);

    const timer = window.setTimeout(() => this.dismiss(el), ttlMs);
    el.dataset.timer = String(timer);
  }

  private dismiss(el: HTMLElement): void {
    if (el.classList.contains("leaving")) return;
    window.clearTimeout(Number(el.dataset.timer));
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }
}
