import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend build. The Worker serves `dist/client` as static assets (see wrangler.jsonc).
// In development, `/api` is proxied to `wrangler dev` (default port 8787).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
});
