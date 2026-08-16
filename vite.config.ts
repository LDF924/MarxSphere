import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

export default defineConfig({
  root: "web",
  plugins: [react()],
  css: {
    // V253: postcss 配置内联——vite 8 (rolldown) 加载外部 postcss.config.js 时
    // tailwind 拿不到正确的 searchPath → content 为空 → JIT 空 utilities → CSS 缺工具类 → 布局错乱
    // 内联后 tailwind/autoprefixer 直接注册，tailwind.config.js 由 tailwind 按 cwd 向上查找（项目根）
    postcss: {
      plugins: [tailwindcss(), autoprefixer()]
    }
  },
  server: {
    port: 4174,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/health": "http://127.0.0.1:4173",
      "/sources": "http://127.0.0.1:4173",
      "/ingest": "http://127.0.0.1:4173",
      "/search": "http://127.0.0.1:4173",
      "/events": "http://127.0.0.1:4173"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
