import { createRouter, createWebHashHistory } from "vue-router";
import PlaceholderView from "./views/PlaceholderView.vue";

// 闭源 11 路由表(route-chunk-map.md + decoded-workflow-INDEX.md §双产品线路由)
// 父级 React 自写 location.hash 路由与 vue-router hash 冲突 → iframe 自带独立 hash, 本路由用 createWebHashHistory
// 视图按模块批次(M1-M6)逐步落地; 未落地路径先给占位, 避免构建期断链
// 延迟 import(每批模块落地后替换 PlaceholderView): 每批模块落地后替换占位
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/workflow/input" },
    // —— M5 在线科研工作流(双产品线 A: 传统分步) ——
    { path: "/workflow", component: PlaceholderView, meta: { title: "工作流" } },
    { path: "/workflow/input", component: () => import("./views/workflow/InputView.vue"), meta: { title: "信息录入", fixedLayout: true } },
    { path: "/workflow/sections", component: () => import("./views/workflow/SectionsView.vue"), meta: { title: "科研架构", fixedLayout: true } },
    { path: "/workflow/materials", component: () => import("./views/workflow/MaterialsView.vue"), meta: { title: "素材准备", fixedLayout: true } },
    { path: "/workflow/workspace", component: () => import("./views/workflow/WorkspaceView.vue"), meta: { title: "文本创作", fixedLayout: true } },
    { path: "/workflow/finalize", component: () => import("./views/workflow/FinalizeView.vue"), meta: { title: "合稿定稿", fixedLayout: true } },
    // —— M6 可视化 DAG(产品线 B) ——
    { path: "/workbench/quick", component: () => import("./views/quick/QuickModeView.vue"), meta: { title: "可视化DAG编排模式", quickAgent: true } },
    // —— M3 数据分析 ——
    { path: "/statistics", component: () => import("./views/statistics/StatisticsView.vue"), meta: { title: "数据分析" } },
    // —— M4 科研绘图 ——
    { path: "/viz", component: () => import("./views/viz/VizView.vue"), meta: { title: "科研绘图" } },
    // —— M2 科研审查 + 审稿库 ——
    { path: "/review", component: () => import("./views/review/ReviewView.vue"), meta: { title: "科研审查" } },
    { path: "/review/library", component: () => import("./views/review/LibraryHome.vue"), meta: { title: "审稿库" } },
    // —— M1 学术文本编辑器 ——
    { path: "/editor", component: () => import("./views/editor/EditorView.vue"), meta: { title: "学术文本编辑器" } },
    { path: "/:pathMatch(.*)*", redirect: "/workflow/input" }
  ]
});
