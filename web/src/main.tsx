import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";
import "./cosmos.css";

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
