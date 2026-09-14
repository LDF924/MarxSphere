import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { installAuthBridge } from "./shared/auth-bridge";
import { installActionBridge } from "./shared/actions-bridge";
import "./styles/main.css";

// 401 → 通知父窗口(React 壳)拉起登录; 见 auth-bridge.ts 的死代码审计说明
installAuthBridge();
// 当前页可执行动作 → 上报父窗口的科研助手; 见 actions-bridge.ts 的由来说明
installActionBridge();

createApp(App).use(createPinia()).use(router).mount("#app");
