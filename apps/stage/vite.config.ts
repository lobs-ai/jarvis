import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 7431,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      "/ws": { target: "ws://127.0.0.1:7430", ws: true },
    },
  },
  // emptyOutDir false: hashed assets from PREVIOUS builds stay on disk, so an
  // already-open tab can still lazy-load its mermaid diagram chunks after a
  // rebuild (deleting them 404'd "Failed to fetch dynamically imported
  // module"). bin/jarvis prunes assets older than 7 days at build time.
  build: { target: "es2022", emptyOutDir: false },
});
