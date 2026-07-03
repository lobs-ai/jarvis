// Tiny query helper shared across the UI modules: throws loudly if an element
// the code depends on is missing from index.html, so a markup rename fails fast
// instead of silently no-op'ing.
export function $<T extends HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
}
