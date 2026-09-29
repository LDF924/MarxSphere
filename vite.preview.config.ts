// 预览专用：root 指到 web/，与根目录的 vite.config.ts（构建生产产物用）不是一回事。
// 两者端口/代理/产物流向都不同 —— 改之前先确认你要改的是哪一个。
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
