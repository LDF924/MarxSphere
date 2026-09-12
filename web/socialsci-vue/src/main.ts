import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { installAuthBridge } from "./shared/auth-bridge";
import "./styles/main.css";

// 401 → 通知父窗口(React 壳)拉起登录; 见 auth-bridge.ts 的死代码审计说明
installAuthBridge();

createApp(App).use(createPinia()).use(router).mount("#app");
