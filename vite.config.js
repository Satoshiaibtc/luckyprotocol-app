import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// LuckyProtocol web — plain Vite + React SPA. No PWA, no service worker: the
// app is a thin console over the indexer + UniSat, and a cached shell that
// could serve a stale tip / supply view is worse than a hard reload.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    // Vite's default budget is fine for this bundle; keep the warning
    // meaningful instead of silencing it.
    chunkSizeWarningLimit: 800,
    sourcemap: false,
  },
});
