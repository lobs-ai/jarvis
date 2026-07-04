import type { ActivityEvent } from "@jarvis/protocol";

// Layer 3 — ambient wiki drafting. When a session ends, jarvisd reads the
// just-closed JSONL ITSELF, distills it, and inlines the transcript into the
// subagent instruction. The tier-2 sandbox has no file-read guarantee by
// design contract — the guardrail is that the transcript read happens in
// jarvisd, never as "here's a path, go read it" handed to the child. The
// instruction reaches the child on stdin (stream-json), never argv.

// Enough conversation to be worth drafting over: at least one real exchange.
export function hasSubstance(events: ActivityEvent[]): boolean {
  return (
    events.some((e) => e.kind === "heard") &&
    events.some((e) => e.kind === "say")
  );
}

// Compact, human-shaped transcript: what was said, what was shown, what was
// done — no thinking, no tool payloads (the draft judges Rafe's words, not
// Jarvis's mechanics, and the inline text should stay small).
export function distillTranscript(events: ActivityEvent[]): string {
  // system turns (stage-fault corrections, announcements) aren't Rafe's words —
  // their "heard" lines must never read as things Rafe said
  const systemTurns = new Set(
    events
      .filter((e) => e.kind === "turn" && e.phase === "begin" && e.source === "system")
      .map((e) => e.turn),
  );
  const lines: string[] = [];
  for (const e of events) {
    if (e.kind === "heard" && !systemTurns.has(e.turn)) lines.push(`Rafe: ${e.text}`);
    else if (e.kind === "say") lines.push(`Jarvis: ${e.text}`);
    else if (e.kind === "exhibit" && e.op === "show")
      lines.push(`[Jarvis showed: ${e.title ?? e.ref ?? e.exhibitId}]`);
    else if (e.kind === "tool" && e.status !== "running" && e.agent === "main")
      lines.push(`[Jarvis ran: ${e.name}]`);
  }
  const text = lines.join("\n");
  // keep the inline transcript bounded; favor the tail (the end of a session
  // is where conclusions live)
  const CAP = 12_000;
  if (text.length <= CAP) return text;
  return `${text.slice(0, 3_000)}\n[… ${text.length - 11_000} chars elided …]\n${text.slice(-8_000)}`;
}

export function buildAmbientDraftTask(transcript: string): string {
  return `A conversation between Rafe and Jarvis just ended. Read the transcript below and \
decide whether something DURABLY TRUE ABOUT RAFE surfaced — a fact about his life, work, \
projects, tools, opinions, or relationships that belongs in his personal wiki. Be strict: \
prefer proposing nothing over proposing something speculative. Transient tasks, one-off \
questions, and anything Jarvis said without Rafe's confirmation do not qualify.

If something qualifies: find the right page (wiki_list / wiki_search / wiki_read), and use \
wiki_propose_edit to stage the SMALLEST correct change — extend the right section of an \
existing page over creating a new one. At most 2 proposals. You cannot commit; Rafe reviews \
each diff and may simply ignore them, which is a fine outcome.

If nothing qualifies, do nothing and reply exactly: no proposals.

Transcript:
---
${transcript}
---`;
}
