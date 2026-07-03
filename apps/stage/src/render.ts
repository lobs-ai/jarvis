// Rich content rendering for exhibits: markdown via marked, fenced code
// syntax-highlighted with highlight.js, and ```mermaid fences rendered to
// live SVG diagrams (flowchart/sequence/pie/xychart/timeline/mindmap/gantt)
// themed to the stage palette. All local — the stage stays offline-capable.
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import mermaid from "mermaid";

hljs.registerLanguage("bash", bash);
hljs.registerAliases(["sh", "zsh", "shell", "console"], { languageName: "bash" });
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerAliases(["js", "jsx"], { languageName: "javascript" });
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerLanguage("python", python);
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerLanguage("xml", xml);
hljs.registerAliases(["html"], { languageName: "xml" });
hljs.registerLanguage("yaml", yaml);
hljs.registerAliases(["yml", "toml"], { languageName: "yaml" });

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  fontFamily: '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif',
  themeVariables: {
    darkMode: true,
    background: "#0b1220",
    primaryColor: "#101a2e",
    primaryTextColor: "#d7e2f2",
    primaryBorderColor: "#37d3c2",
    secondaryColor: "#0b1220",
    tertiaryColor: "#081020",
    lineColor: "#5aa7ff",
    textColor: "#d7e2f2",
    fontSize: "14px",
  },
});

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang === "mermaid") return code; // handled post-parse, kept verbatim
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          /* fall through to auto */
        }
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

export function renderMarkdown(el: HTMLElement, text: string): void {
  el.innerHTML = marked.parse(text, { async: false }) as string;
  hydrateMermaid(el);
}

export function renderCode(el: HTMLElement, text: string, lang?: string): void {
  if (lang === "mermaid") {
    el.innerHTML = `<pre><code class="language-mermaid">${escapeHtml(text)}</code></pre>`;
    hydrateMermaid(el);
    return;
  }
  const html =
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang }).value
      : escapeHtml(text);
  el.innerHTML = `<pre><code class="hljs">${html}</code></pre>`;
}

// Replace every ```mermaid block under el with its rendered SVG, in place and
// async — the exhibit conjures immediately, diagrams pop in as they compile.
// A diagram that fails to parse keeps its source visible with the error below.
let mermaidSeq = 0;
function hydrateMermaid(el: HTMLElement): void {
  const blocks = el.querySelectorAll<HTMLElement>("code.language-mermaid");
  for (const code of blocks) {
    const source = code.textContent ?? "";
    const pre = code.closest("pre") ?? code;
    const id = `mmd-${++mermaidSeq}`;
    void mermaid
      .render(id, source)
      .then(({ svg }) => {
        const holder = document.createElement("div");
        holder.className = "mermaid-diagram";
        holder.innerHTML = svg;
        pre.replaceWith(holder);
      })
      .catch((err: unknown) => {
        document.getElementById(`d${id}`)?.remove(); // mermaid's leftover error node
        const note = document.createElement("div");
        note.className = "placeholder";
        note.textContent = `diagram error: ${String(err).slice(0, 200)}`;
        pre.after(note);
      });
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
