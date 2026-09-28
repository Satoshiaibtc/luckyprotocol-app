import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// LuckyProtocol web — plain Vite + React SPA. No PWA, no service worker: the
// app is a thin console over the indexer + UniSat, and a cached shell that
// could serve a stale tip / supply view is worse than a hard reload.
export default defineConfig(({ mode }) => {
  // A production bundle must never ship the fake indexer / simulated
  // wallet (audit L-16): fail the build instead of shipping a demo.
  const env = loadEnv(mode, process.cwd(), "");
  if (mode === "production" && env.VITE_MOCK === "1") {
    throw new Error("VITE_MOCK=1 is set for a production build — the mock indexer must never ship; unset it (it belongs in .env.development only)");
  }
  // The commit a Cloudflare Pages build was made from (CF_PAGES_COMMIT_SHA,
  // set by Pages; empty for a local build) is printed in the footer, so a
  // build nobody meant to ship is visible to anyone who compares it with
  // the repository (audit web-1).
  const commit = String(process.env.CF_PAGES_COMMIT_SHA || "").replace(/[^0-9a-f]/gi, "").slice(0, 12);
  return { ...config, define: { "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(commit) } };
});

const config = {
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
};
