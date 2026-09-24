/** @type {import('tailwindcss').Config} */
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export default {
  content: [path.join(root, "index.html"), path.join(root, "src", "**/*.{vue,ts}")],
  /**
   * ⚠ 2026-09-24: 让 Tailwind 的**类名扫描器**别再扫源码里的正则。
   *
   * 起因: `npm run build:socialsci-vue` 在 main 上本来就是**红的** ——
   *   lightningcss 报 `[lightningcss minify] Unexpected token Semicolon`, 指向一条荒谬的规则
   *   `.\[-\:\|\\s\]{ -: |\s; }`。
   *   它不是手写的 CSS, 是扫描器把 VizChatPanelV2.vue 里这行正则的字符类
   *   `/(^\|.+\|$)\n((^\|[-:|\s]+\|$)\n)?…/` 里的 `[-:|\s]` 当成了一个任意值类名(arbitrary value),
   *   提取出来生成了 CSS。未压缩构建不崩, 只有**压缩**时 lightningcss 的解析器受不了。
   *
   * 两条一起修:
   *   ① 这里 blocklist 掉这个形状(治根: 从源头不生成);
   *   ② vite.config 把 cssMinify 换成 esbuild(兜底: 将来别的文件再生成怪规则也不至于构建失败)。
   *   ② 刻意选 esbuild —— 同一依赖树里已有, 零新依赖, 且对未知属性宽容。
   */
  blocklist: [/\[-:.*\]/],
  corePlugins: { preflight: false }, // 不重置父级 React 产品全局样式? 本子工程独立 HTML(iframe) → preflight 无碍, 但保守起见关闭
  theme: { extend: {} },
  plugins: []
};
