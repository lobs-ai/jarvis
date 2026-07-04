import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Snapshot of the wiki taken when the CLI child spawns, baked into the system
// prompt so Jarvis knows what it knows about Rafe without a lookup round-trip.
// The index.md catalog (one line per page, maintained by the wiki's own ingest)
// is the semantic map; the path list is what wiki_read and wiki: refs take.
// A wiki_dir settings change restarts the conversation, which re-snapshots.

export interface WikiSnapshot {
  pages: string[]; // relative .md paths, sorted
  index: string | null; // contents of index.md if the wiki keeps one
}

const INDEX_CAP = 24_000; // chars; index.md is ~12.6K today — cap the blast radius
const PAGE_CAP = 400;

export function snapshotWiki(dir: string): WikiSnapshot {
  const pages: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(relPath);
      else if (e.name.endsWith(".md")) pages.push(relPath);
    }
  };
  walk("");
  pages.sort();
  if (pages.length > PAGE_CAP) pages.length = PAGE_CAP;

  let index: string | null = null;
  try {
    index = readFileSync(join(dir, "index.md"), "utf8").slice(0, INDEX_CAP).trim() || null;
  } catch {
    /* no index page — the path list still carries the section */
  }
  return { pages, index };
}
