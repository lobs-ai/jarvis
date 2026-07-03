import { randomUUID } from "node:crypto";

// Confirmation broker for mutate-class actions (design §Security model).
// A spoken yes counts only on EXACT match of a fixed phrase set — never an
// STT-confidence judgment; the stage click always works.
export const CONFIRM_PHRASES = ["yes", "yes commit", "commit it", "do it", "go ahead"];

const CONFIRM_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (approved: boolean) => void;
  summary: string;
}

export class ConfirmBroker {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly sendRequest: (confirmId: string, summary: string, detail: string | undefined, phrases: string[]) => void,
    private readonly sendResolved: (confirmId: string, approved: boolean) => void,
  ) {}

  request(summary: string, detail?: string): Promise<boolean> {
    const confirmId = randomUUID().slice(0, 8);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolve(confirmId, false), CONFIRM_TIMEOUT_MS);
      this.pending.set(confirmId, {
        summary,
        resolve: (approved) => {
          clearTimeout(timer);
          resolve(approved);
        },
      });
      this.sendRequest(confirmId, summary, detail, CONFIRM_PHRASES);
    });
  }

  resolve(confirmId: string, approved: boolean): void {
    const p = this.pending.get(confirmId);
    if (!p) return;
    this.pending.delete(confirmId);
    this.sendResolved(confirmId, approved);
    p.resolve(approved);
  }

  // Called with each new utterance/text input BEFORE it becomes a turn: an
  // exact-match phrase resolves the newest pending confirm instead.
  tryPhrase(input: string): boolean {
    if (this.pending.size === 0) return false;
    const norm = input.toLowerCase().replace(/[^a-z ]/g, "").trim();
    const newest = [...this.pending.keys()].pop()!;
    if (CONFIRM_PHRASES.includes(norm)) {
      this.resolve(newest, true);
      return true;
    }
    if (["no", "cancel", "stop", "dont"].includes(norm)) {
      this.resolve(newest, false);
      return true;
    }
    return false;
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }
}
