import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Dev: the page is served by Vite on :5173 and proxies the API, the live WebSocket and the
// /download route to onebase on :8090, so the browser only ever talks to one origin.
// Prod: `vite build` writes dist/, which onebase serves itself (--public dist).
const backend = process.env.ONEBASE_URL ?? "http://127.0.0.1:8090";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, ws: true, changeOrigin: false },
      "/download": { target: backend },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
