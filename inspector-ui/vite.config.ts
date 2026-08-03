import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Port to run `umg0 inspect --api-only --port 7788` on while developing. */
const API_PORT = 7788;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Assets are served from /, but relative paths keep the build portable if
  // the inspector ever moves under a subpath.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Committed to git and diffed by scripts/check-inspector-assets.mjs.
    sourcemap: false,
    reportCompressedSize: false,
  },
  server: {
    proxy: {
      // changeOrigin so the Host header matches the inspector's loopback check.
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
