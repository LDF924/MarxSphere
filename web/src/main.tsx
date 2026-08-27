// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { registerView } from "./components/viewRegistry";
import { JupyterPanel } from "./components/JupyterPanel";
import "./styles.css";
import "./cosmos.css";

// 2026-08-27: 轻量 notebook 工作台（ScienceX 通用计算环境）— 插件面板注册
registerView({
  value: "jupyter",
  label: "Notebook 工作台",
  labelEn: "Notebook",
  category: "core",
  component: JupyterPanel,
  desc: "Python 单元执行 · 持久变量 · 图表输出（复用实证沙箱 venv）",
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
