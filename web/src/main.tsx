// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { registerView } from "./components/viewRegistry";
import { JupyterPanel } from "./components/JupyterPanel";
import { BackupPanel } from "./components/BackupPanel";
import { FormatEvalPanel } from "./components/FormatEvalPanel";
import "./styles.css";
import "./cosmos.css";
import "./learning.css";

// 2026-08-27: 轻量 notebook 工作台（ScienceX 通用计算环境）— 插件面板注册
registerView({
  value: "jupyter",
  label: "Notebook 工作台",
  labelEn: "Notebook",
  category: "core",
  component: JupyterPanel,
  desc: "Python 单元执行 · 持久变量 · 图表输出（复用实证沙箱 venv）",
});

// 2026-09-01: 知识库备份/恢复(.sagbak, Zleap 评审 P1)
registerView({
  value: "backup",
  label: "备份/恢复",
  labelEn: "Backup",
  category: "knowledge",
  component: BackupPanel,
  desc: "知识库快照 · 校验 · 全量恢复(PG + Graphiti/Cognee 图谱)",
});

// 2026-09-03: 论文格式智能评测(规则引擎 + LLM 双层)
registerView({
  value: "format-eval",
  label: "格式智能评测",
  labelEn: "Format Eval",
  category: "literature",
  component: FormatEvalPanel,
  dot: "hsl(160 60% 50%)",
  desc: "学位论文/期刊/职称格式评测 · 细粒度规则引擎 + LLM 审校 · 自定义学校模板",
});

// V398: 主题初始化（render 前，防首屏闪烁）— 默认深色，浅色需用户切换
// localStorage 键 sag:theme:v1："dark" | "light"
const storedTheme = (() => {
  try {
    return window.localStorage.getItem("sag:theme:v1");
  } catch {
    return null;
  }
})();
const theme = storedTheme === "light" ? "light" : "dark";
document.documentElement.classList.toggle("light", theme === "light");
document.documentElement.classList.toggle("dark", theme === "dark");

// ── SocialSci 闭源 Vue3 反混淆还原 6 模块嵌入(方案 A) ──
// 宿主组件在 iframe 内嵌独立构建的 web/dist/soc(后端 fastify-static 已托管), route=子应用 hash 路由
import SocialSciVueHost from "./components/SocialSciVueHost";
import { SOCIALSCI_ROUTES } from "./components/SocialSciVueHost";

SOCIALSCI_ROUTES.forEach((def) => {
  registerView({
    value: def.key,
    label: def.label,
    labelEn: def.label,
    category: "tools",
    component: () => <SocialSciVueHost route={def.route} label={def.label} />,
    dot: "hsl(214 60% 55%)",
    desc: `社科研修云 · ${def.label}(Vue3 还原版)`,
  });
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
