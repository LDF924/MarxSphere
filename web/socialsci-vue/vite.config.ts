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
