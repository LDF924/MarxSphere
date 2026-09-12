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
      "/events": "http://127.0.0.1:4173",
      // SocialSci Vue 子应用 dev 直连(独立 vite 5174; 生产走 fastify-static web/dist/soc)
      "/soc": "http://127.0.0.1:5174"
    }
  },
  build: {
    outDir: "dist",
    // V414: 整个仓库只有这一处必须关掉 emptyOutDir —— web/dist 是"两个构建共享"的目录:
    //   React(本配置, root=web) 产出 assets/ + index.html;
    //   SocialSci Vue 子应用(root=web/socialsci-vue, base=/soc/) 产出 soc/,
    //   由 fastify-static 按同一 root 托管, 5 个 iframe tab 全靠它。
    //   开 true 时 `vite build` 单独的 build:web 会连 soc/ 一起清掉, 而 package.json
    //   的 build 之所以没暴露这个问题, 只是因为凑巧按 build:web → build:socialsci-vue 的顺序补了回来。
    //   实测后果: 点击「课题流程编排」等 5 个 tab, iframe 落到 SPA 兜底 → 渲染成 AI 对话页。
    //   陈旧 chunk 交给下面的 clean:web 清理(dist/ 的清理入口只有它一处, 语义清晰)。
    emptyOutDir: false
  }
});
