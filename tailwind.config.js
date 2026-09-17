// V253: content 用绝对路径（基于本文件位置）——Tailwind 按构建进程 cwd 解析相对路径，
// 从 web/ 目录直接 vite build 时 "./web/..." 失效 → JIT 空 utilities → CSS 缺失工具类 → 布局错乱
// 项目 type=module，ESM 格式是原生形态（vite/rolldown import() 加载最稳）
import { fileURLToPath } from "node:url";
import path from "node:path";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "web");


/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  /**
   * ⚠ V417(2026-09-16): 子应用(web/socialsci-vue)的类名此前**从未被扫描到**。
   *
   * 那个子应用有自己的 `tailwind.config.js`(content 指向 `*.{vue,ts}`), 但它的
   * `vite.config.ts` 用 `tailwindcss()` **不传 config** —— 而它跑在主仓的 vite 进程里,
   * Tailwind 按 cwd 解析到的是**本文件**。于是 `.vue` 里的类名写了也不生成 CSS。
   *
   * 实测: `max-w-5xl`(3 处) / `pb-16`(4 处) 在产物 `web/dist/soc/assets/*.css` 里 **0 条** ——
   * 三个页面因此整幅宽(该是 max-width 约束+居中)、底部没有留白。
   * `max-w-4xl`/`space-y-6`/`p-5` 之所以有, 只是因为 React 侧也用了同样的类名(侥幸)。
   *
   * ⚠ **不能**直接往 content 里加 `socialsci-vue/src/**\/*.vue`: Tailwind 的正则提取器会把
   * `.vue` 模板里的**字符串与正则片段**也当类名(实测撞到 `[-\:\|\s]` → 生成非法 CSS
   * `.-: |\s;` → lightningcss 报 "Unexpected token Semicolon" 直接构建失败)。
   * 子应用实际用到的工具类很少, 显式 safelist 更可控。
   *
   * 同源教训见上面的 V253 注释: 这里已是第二次因"Tailwind 按 cwd 解析"而静默丢样式。
   */
  content: [
    path.join(webRoot, "index.html"),
    path.join(webRoot, "src", "**/*.{ts,tsx}"),
  ],
  safelist: [
    // web/socialsci-vue 里实际用到的工具类(用 `grep -rhoE 'class="[^"]*"' .../*.vue` 盘点得出)。
    // 该子应用其余样式都走 `<style scoped>` 语义类, 不依赖 Tailwind。
    "max-w-4xl", "max-w-5xl",
    "p-6", "px-2", "px-3", "px-4", "px-6", "py-1", "py-2", "py-3", "py-4", "py-8",
    "pb-16", "mb-1", "gap-3", "space-y-4",
    "text-xs", "text-sm", "text-lg", "text-2xl",
    "rounded-lg", "rounded-2xl", "w-0",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))"
        },
        popover: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--foreground))"
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--foreground))"
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))"
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))"
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))"
        }
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)"
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)"
      }
    }
  },
  plugins: []
};
