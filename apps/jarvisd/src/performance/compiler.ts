import { Exhibit, type PerformanceItem } from "@jarvis/protocol";

// Incremental parser over streamed text deltas.
//
// Prose outside stage-directive tags becomes sentence-segmented `say` items;
// <show/>, <update>, <dismiss/> tags become items at their exact position in the
// prose. The model is taught (Appendix B) to place tags at sentence boundaries;
// if one lands mid-sentence we flush the partial prose first so choreography
// order is preserved at some prosody cost.

const TAG_OPEN = /<(show|update|dismiss|focus)\b/;
// Trailing text that could be the start of a tag on the next delta — hold it back.
const PARTIAL_TAG_TAIL = /<(?:s(?:h(?:ow?)?)?|u(?:p(?:d(?:a(?:te?)?)?)?)?|d(?:i(?:s(?:m(?:i(?:ss?)?)?)?)?)?|f(?:o(?:c(?:us?)?)?)?)?$/;

const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|dr|mr|mrs|ms|st|no|v[0-9]*)\.$/i;

// Opener clause-split thresholds (design: only when the first sentence would
// otherwise blow the first-audio latency line).
const OPENER_SPLIT_MIN_CHARS = 90;
const OPENER_CLAUSE_MIN_CHARS = 30;

export interface CompilerEvents {
  onItem: (item: PerformanceItem) => void;
  onWarning: (message: string) => void;
}

export class PerformanceCompiler {
  private buffer = "";
  private seq = 0;
  private saidAnything = false;
  private closed = false;

  constructor(
    private readonly turnId: string,
    private readonly events: CompilerEvents,
  ) {}

  push(delta: string): void {
    if (this.closed) return;
    this.buffer += delta;
    this.drain(false);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.drain(true);
  }

  get nextSeq(): number {
    return this.seq;
  }

  private drain(atEnd: boolean): void {
    for (;;) {
      const tagStart = this.buffer.search(TAG_OPEN);
      if (tagStart === -1) {
        // No complete tag opener in sight. Hold back a possible partial "<sho…" tail.
        const holdFrom = atEnd ? this.buffer.length : this.safeProseLength();
        this.flushProse(holdFrom, atEnd);
        return;
      }
      // Flush ALL prose before the tag (a directive follows, so the fragment is final).
      this.flushProse(tagStart, true);
      if (!this.buffer.startsWith("<")) return; // shouldn't happen, defensive
      if (!this.tryConsumeTag()) return; // tag incomplete; wait for more deltas
    }
  }

  private safeProseLength(): number {
    const m = this.buffer.match(PARTIAL_TAG_TAIL);
    return m ? this.buffer.length - m[0].length : this.buffer.length;
  }

  // Emit say items from buffer[0, limit). If flushAll, everything up to limit is
  // emitted (trailing fragment included) and consumed; otherwise only complete
  // sentences are consumed and the tail stays buffered.
  private flushProse(limit: number, flushAll: boolean): void {
    if (limit <= 0) return;
    const region = this.buffer.slice(0, limit);

    let consumed = 0; // index into region up to which we've emitted
    const boundary = /[.!?](?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = boundary.exec(region)) !== null) {
      const candidate = region.slice(consumed, m.index + 1);
      if (ABBREVIATIONS.test(candidate.trimEnd())) continue;
      // consume trailing whitespace after the boundary
      let end = m.index + 1;
      while (end < region.length && /\s/.test(region[end]!)) end++;
      this.emitSentence(candidate.trim());
      consumed = end;
    }

    if (flushAll) {
      const tail = region.slice(consumed).trim();
      if (tail) this.emitSentence(tail);
      consumed = limit;
    }
    this.buffer = this.buffer.slice(consumed);
  }

  private emitSentence(sentence: string): void {
    if (!sentence) return;
    if (!this.saidAnything && sentence.length >= OPENER_SPLIT_MIN_CHARS) {
      const comma = sentence.indexOf(", ", OPENER_CLAUSE_MIN_CHARS);
      if (comma !== -1 && comma < sentence.length - 20) {
        this.emitSay(sentence.slice(0, comma + 1));
        this.emitSay(sentence.slice(comma + 2));
        return;
      }
    }
    this.emitSay(sentence);
  }

  private emitSay(text: string): void {
    this.saidAnything = true;
    this.events.onItem({ kind: "say", seq: this.seq++, turnId: this.turnId, text });
  }

  // Attempt to consume one complete tag at buffer position 0.
  private tryConsumeTag(): boolean {
    const openEnd = this.buffer.indexOf(">");
    if (openEnd === -1) return false;
    const openTag = this.buffer.slice(0, openEnd + 1);
    const nameMatch = openTag.match(TAG_OPEN);
    if (!nameMatch || !openTag.startsWith("<")) {
      // Defensive: treat as prose so the stream never stalls.
      this.emitSay(openTag);
      this.buffer = this.buffer.slice(openEnd + 1);
      return true;
    }
    const name = nameMatch[1] as "show" | "update" | "dismiss" | "focus";
    const selfClosing = /\/>\s*$/.test(openTag);

    let payload = "";
    let consumedTo = openEnd + 1;
    if (!selfClosing) {
      const closer = `</${name}>`;
      const closeAt = this.buffer.indexOf(closer, openEnd + 1);
      if (closeAt === -1) return false; // wait for the rest
      payload = this.buffer.slice(openEnd + 1, closeAt);
      consumedTo = closeAt + closer.length;
    }

    const attrs = parseAttrs(openTag);
    this.buffer = this.buffer.slice(consumedTo);
    this.emitDirective(name, attrs, payload);
    return true;
  }

  private emitDirective(
    name: "show" | "update" | "dismiss" | "focus",
    attrs: Record<string, string>,
    payload: string,
  ): void {
    if (name === "dismiss") {
      if (!attrs.ref) return this.warn("dismiss without ref");
      this.events.onItem({ kind: "dismiss", seq: this.seq++, turnId: this.turnId, ref: attrs.ref });
      return;
    }
    if (name === "focus") {
      if (!attrs.ref) return this.warn("focus without ref");
      const zoom = attrs.zoom !== undefined ? Number(attrs.zoom) : undefined;
      if (zoom !== undefined && (!Number.isFinite(zoom) || zoom <= 0 || zoom > 8)) {
        return this.warn(`focus with invalid zoom "${attrs.zoom}"`);
      }
      this.events.onItem({
        kind: "focus",
        seq: this.seq++,
        turnId: this.turnId,
        ref: attrs.ref,
        ...(zoom !== undefined ? { zoom } : {}),
      });
      return;
    }
    if (name === "update") {
      if (!attrs.ref) return this.warn("update without ref");
      const mermaidFault = firstMarkdownMermaidFault(payload);
      if (mermaidFault) {
        return this.warn(
          `<update ref="${attrs.ref}">: ${mermaidFault} — dropped; re-issue with corrected mermaid`,
        );
      }
      this.events.onItem({
        kind: "update",
        seq: this.seq++,
        turnId: this.turnId,
        ref: attrs.ref,
        body: payload,
      });
      return;
    }
    const id = attrs.id;
    if (!id) return this.warn("show without id");
    const raw: Record<string, unknown> = stripUndefined({
      type: attrs.type ?? (attrs.lang ? "code" : "markdown"),
      title: attrs.title,
      lang: attrs.lang,
      ref: attrs.ref,
      src: attrs.src,
    });
    if (payload.trim()) {
      if (raw.type === "image") raw.src = payload.trim();
      else raw.body = payload.replace(/^\n/, "").replace(/\n[ \t]*$/, "");
    }
    const parsed = Exhibit.safeParse(raw);
    if (!parsed.success) {
      return this.warn(
        `malformed <show id="${id}">: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      );
    }
    const d = parsed.data;
    const hasContent =
      d.ref !== undefined ||
      (d.type === "image" ? d.src !== undefined : d.body !== undefined);
    if (!hasContent) return this.warn(`<show id="${id}"> has neither ref nor payload`);
    // Pre-flight any inline mermaid before it ships: a contaminated diagram would
    // reach the stage and fail to draw. Drop it here so it never appears broken —
    // the model re-issues via the directive-dropped fault loop.
    const mermaidFault = firstExhibitMermaidFault(d);
    if (mermaidFault) {
      return this.warn(`<show id="${id}">: ${mermaidFault} — dropped; re-issue with corrected mermaid`);
    }
    this.events.onItem({ kind: "show", seq: this.seq++, turnId: this.turnId, id, exhibit: d });
  }

  private warn(message: string): void {
    // design rule: malformed markup drops to a caption warning, never spoken
    this.events.onWarning(message);
  }
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) attrs[m[1]!] = m[2]!;
  return attrs;
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

// ── mermaid pre-flight ──────────────────────────────────────────────────────
// The stage feeds ```mermaid source verbatim to mermaid.parse; a stray closing
// ``` fence or an HTML tag leaking in from a mis-terminated block makes it throw
// and never draw (the class of failure Rafe kept hitting). We can't run mermaid
// here — it needs a browser DOM — and validation must stay synchronous so it
// doesn't stall the streamed performance. But these markers never appear in valid
// mermaid, so a cheap structural check drops the bad directive before it ships;
// the model then re-issues it, corrected, through the directive-dropped fault
// loop. Genuine syntax errors that slip past are still caught by the stage's own
// mermaid.parse (which also faults).
const LEAKED_HTML =
  /<\/(?:span|div|p|code|pre|section|article|main|body|html|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|h[1-6])\b[^>]*>/i;

function mermaidLint(source: string): string | null {
  const body = source.trim();
  if (!body) return "empty mermaid diagram";
  if (body.includes("```")) return "a stray ``` fence leaked into the mermaid diagram";
  const tag = body.match(LEAKED_HTML);
  if (tag) return `a stray ${tag[0]} tag leaked into the mermaid diagram`;
  return null;
}

// Slice the source of each ```mermaid fence out of a markdown payload the way the
// stage's parser does: content runs from the opener to a line that is exactly ```
// A mistyped closer (e.g. ```</span>) is NOT a clean close, so its junk stays in
// the block and gets flagged — precisely the contamination we want to catch.
function mermaidFences(markdown: string): string[] {
  const blocks: string[] = [];
  let buf: string[] | null = null;
  for (const line of markdown.split("\n")) {
    if (buf === null) {
      if (/^[ \t]{0,3}```[ \t]*mermaid\b/i.test(line)) buf = [];
      continue;
    }
    if (/^[ \t]{0,3}```[ \t]*$/.test(line)) {
      blocks.push(buf.join("\n"));
      buf = null;
      continue;
    }
    buf.push(line);
  }
  if (buf !== null) blocks.push(buf.join("\n")); // unterminated fence: lint what's there
  return blocks;
}

function firstMarkdownMermaidFault(markdown: string): string | null {
  for (const block of mermaidFences(markdown)) {
    const fault = mermaidLint(block);
    if (fault) return fault;
  }
  return null;
}

function firstExhibitMermaidFault(d: Exhibit): string | null {
  if (d.type === "code" && d.lang === "mermaid" && d.body !== undefined) {
    return mermaidLint(d.body);
  }
  if (d.type === "markdown" && d.body !== undefined) {
    return firstMarkdownMermaidFault(d.body);
  }
  return null;
}
