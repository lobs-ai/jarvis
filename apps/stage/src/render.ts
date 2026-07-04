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
import { reloadOnChunkFailure } from "./reload.js";

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

// Stage-native mermaid skin. The stock "dark" theme leaves flat gray subgraph
// slabs and mismatched fills — "base" hands every color over to us, and
// themeCSS adds what variables can't reach (rounded nodes, teal glow, soft
// cluster tints). Same engine, Jarvis's look.
const INK = "#d7e2f2";
const INK_DIM = "#7d8ca3";
const TEAL = "#37d3c2";
const SKY = "#5aa7ff";
const SURFACE = "#101a2e";
const SURFACE_DEEP = "#0b1220";

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  fontFamily: '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif',
  flowchart: { curve: "basis", nodeSpacing: 42, rankSpacing: 48, padding: 10 },
  themeVariables: {
    darkMode: true,
    background: "transparent",
    fontSize: "14px",
    // nodes
    primaryColor: SURFACE,
    primaryTextColor: INK,
    primaryBorderColor: "rgba(55, 211, 194, 0.55)",
    secondaryColor: SURFACE_DEEP,
    secondaryBorderColor: "rgba(90, 167, 255, 0.4)",
    secondaryTextColor: INK,
    tertiaryColor: "rgba(90, 167, 255, 0.07)",
    tertiaryBorderColor: "rgba(90, 167, 255, 0.25)",
    tertiaryTextColor: INK,
    mainBkg: SURFACE,
    nodeBorder: "rgba(55, 211, 194, 0.55)",
    nodeTextColor: INK,
    // edges + labels
    lineColor: "rgba(90, 167, 255, 0.75)",
    textColor: INK,
    edgeLabelBackground: SURFACE_DEEP,
    // subgraphs/clusters (the flat gray slabs in the stock theme)
    clusterBkg: "rgba(90, 167, 255, 0.06)",
    clusterBorder: "rgba(90, 167, 255, 0.28)",
    titleColor: TEAL,
    // sequence diagrams
    actorBkg: SURFACE,
    actorBorder: "rgba(55, 211, 194, 0.55)",
    actorTextColor: INK,
    actorLineColor: INK_DIM,
    signalColor: INK,
    signalTextColor: INK,
    labelBoxBkgColor: SURFACE_DEEP,
    labelBoxBorderColor: "rgba(90, 167, 255, 0.28)",
    labelTextColor: INK,
    loopTextColor: INK,
    noteBkgColor: "rgba(255, 179, 90, 0.12)",
    noteBorderColor: "rgba(255, 179, 90, 0.4)",
    noteTextColor: INK,
    activationBkgColor: "rgba(55, 211, 194, 0.15)",
    activationBorderColor: TEAL,
    // pie / charts: teal→sky ramp instead of default rainbow
    pie1: TEAL, pie2: SKY, pie3: "#6fe3a5", pie4: "#ffb35a",
    pie5: "#9ef3ea", pie6: "#b8d9ff", pie7: "#1d7d74", pie8: "#14488f",
    pieTitleTextColor: INK,
    pieSectionTextColor: INK,
    pieLegendTextColor: INK,
    pieStrokeColor: SURFACE_DEEP,
    pieOuterStrokeColor: "rgba(90, 167, 255, 0.28)",
    // gantt/timeline odds and ends
    gridColor: "rgba(125, 140, 163, 0.2)",
    todayLineColor: TEAL,
  },
  themeCSS: `
    .node rect, .node polygon, .node circle, .node ellipse {
      rx: 8px; ry: 8px;
      filter: drop-shadow(0 0 6px rgba(55, 211, 194, 0.18));
    }
    .cluster rect { rx: 12px; ry: 12px; }
    .cluster-label .nodeLabel, .cluster-label span {
      fill: ${TEAL}; color: ${TEAL};
      font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
    }
    .edgePaths path { stroke-width: 1.4px; }
    .edgeLabel { border-radius: 4px; }
    .nodeLabel, .edgeLabel { font-weight: 500; }
  `,
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
        // A rebuild may have removed this bundle's lazy diagram chunk — reload
        // onto the current bundle rather than reporting a dead diagram.
        if (reloadOnChunkFailure(err)) return;
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
