/** @type {import('tailwindcss').Config} */
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export default {
  content: [path.join(root, "index.html"), path.join(root, "src", "**/*.{vue,ts}")],
  corePlugins: { preflight: false }, // 不重置父级 React 产品全局样式? 本子工程独立 HTML(iframe) → preflight 无碍, 但保守起见关闭
  theme: { extend: {} },
  plugins: []
};
