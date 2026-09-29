import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:4199",
      "/health": "http://127.0.0.1:4199",
      "/sources": "http://127.0.0.1:4199",
      "/ingest": "http://127.0.0.1:4199",
      "/search": "http://127.0.0.1:4199",
      "/events": "http://127.0.0.1:4199"
    }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
