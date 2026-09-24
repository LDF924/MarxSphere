import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { fileURLToPath, URL } from "node:url";

// SocialSci Vue 子工程 — 独立构建, 产物进入 web/dist/soc(父级 fastify-static root=web/dist 托管)
// dev 端口 5174; 父 vite.config 增 proxy /soc → 5174 即可在父 React 内 iframe 直连
const projectRoot = fileURLToPath(new URL(".", import.meta.url)); // web/socialsci-vue/
const webDir = fileURLToPath(new URL("..", import.meta.url)); // web/

export default defineConfig({
  root: projectRoot, // 绝对路径: 无论 cwd 在哪都锚定子工程
  base: "/soc/", // 产物 URL 前缀必须与后端静态根对齐(web/dist/soc/...)
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()]
    }
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4173" }
  },
  build: {
    outDir: fileURLToPath(new URL("../dist/soc", import.meta.url)), // web/dist/soc
    emptyOutDir: true,
    /**
     * ⚠ 2026-09-24: 用 esbuild 压 CSS, 换掉默认的 lightningcss。
     *
     * 起因: `npm run build:socialsci-vue`(CI 里也会跑)在 main 上就是红的 ——
     *   lightningcss 对 Tailwind 扫描器从一行正则里误提取出的规则
     *   `.\[-\:\|\\s\]{ -: |\s; }` 直接报 `Unexpected token Semicolon` 并中断整个构建。
     *   根因那半已由 tailwind.config.js 的 blocklist 治掉(不再生成该规则); 这里留一层兜底 ——
     *   将来若别的文件再生成这类怪规则, 压缩器不该把整个产物干掉。
     *   选 esbuild 而不是关掉压缩: 同一依赖树里已有(零新依赖), 且对未知属性比 lightningcss 宽容。
     */
    cssMinify: "esbuild",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("@tiptap/") || id.includes("@popperjs/") || id.includes("prosemirror-")) return "editor";
          if (id.includes("@vue-flow/")) return "flow";
          if (id.includes("plotly")) return "plotly";
          if (id.includes("pdfjs") || id.includes("pdf-js")) return "pdf";
          return undefined;
        }
      }
    }
  }
});
