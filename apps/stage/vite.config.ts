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
  build: { target: "es2022" },
});
