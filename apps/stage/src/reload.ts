// Stale-asset guard. jarvisd serves a Vite bundle with a content-hashed name
// (/assets/index-<hash>.js). When the daemon restarts with a new build, an open
// tab keeps executing the OLD bundle forever — the reason this UI got rebuilt.
// On every (re)connect we ask the server which bundle it serves now and reload
// once if it differs from the one we're running. sessionStorage keyed on the
// server hash prevents a reload loop if the two never manage to agree.
const KEY = "stage:reloaded-for";

export async function reloadIfStale(): Promise<void> {
  let html: string;
  try {
    html = await (await fetch("/", { cache: "no-store" })).text();
  } catch {
    return; // can't reach the origin — nothing to compare against
  }

  const server = html.match(/\/assets\/(index-[\w-]+\.js)/)?.[1];
  if (!server) return; // dev server serves source (/src/main.ts), no hashed bundle

  const running =
    (document.querySelector<HTMLScriptElement>('script[type="module"]')?.src ?? "") +
    " " +
    import.meta.url;
  if (running.includes(server)) return; // already the current bundle

  if (sessionStorage.getItem(KEY) === server) return; // already reloaded for this hash
  sessionStorage.setItem(KEY, server);
  location.reload();
}

// Self-heal for a failed lazy chunk (mermaid diagram renderers are dynamic
// imports): if a rebuild removed the chunk this bundle wants, reload onto the
// current bundle instead of showing a dead diagram. Keyed to the running
// bundle: one reload attempt per bundle, so a tab that lives across several
// rebuilds can heal each time without ever looping.
export function reloadOnChunkFailure(err: unknown): boolean {
  if (!/dynamically imported module|Importing a module script failed/i.test(String(err))) {
    return false;
  }
  const key = `stage:chunk-reload:${import.meta.url}`;
  if (sessionStorage.getItem(key)) return false; // already tried for this bundle
  sessionStorage.setItem(key, "1");
  location.reload();
  return true;
}
