// V253: ESM 格式（根 package.json 是 type=module，vite 走 import() 加载；
// 改成 CJS 会让 postcss 配置静默失效——样式还在但 Tailwind 不再生成类名。）
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
};
