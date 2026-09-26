import { createRouter, createWebHashHistory } from "vue-router";

// 参考产品 11 路由表(route-chunk-map.md + decoded-workflow-INDEX.md §双产品线路由)
// 父级 React 自写 location.hash 路由与 vue-router hash 冲突 → iframe 自带独立 hash, 本路由用 createWebHashHistory
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/workflow/input" },
    // —— M5 在线科研工作流(双产品线 A: 传统分步) ——
    /**
     * `/workflow` 本身**重定向到第 1 步**, 不给视图。
     *
     * ⚠ 2026-09-26 修: 此前这里挂的是 `PlaceholderView`（整页只有"📦 模块建设中"），
     *   而 InputView 删掉项目后正是 `router.push("/workflow")` —— 用户删完项目就被丢进
     *   一个没有导航、没有返回入口的死页。全仓只有这一条路由会渲染到占位页。
     *   改成重定向后，这条路径怎么来都落在选题界定页。
     */
    { path: "/workflow", redirect: "/workflow/input" },
    { path: "/workflow/input", component: () => import("./views/workflow/InputView.vue"), meta: { title: "选题界定", fixedLayout: true } },
    { path: "/workflow/sections", component: () => import("./views/workflow/SectionsView.vue"), meta: { title: "框架设计", fixedLayout: true } },
    // 2026-09-26 新增: 研究实施 —— 承接第 2 步产出的研究设计（此前设计之后直接跳到"料场"）。
    // 只对定量/混合研究显示（见 shared/stages.ts 的 appliesTo），定性研究看不到这个节点与这条路由。
    { path: "/workflow/implement", component: () => import("./views/workflow/ImplementView.vue"), meta: { title: "研究实施", fixedLayout: true } },
    { path: "/workflow/materials", component: () => import("./views/workflow/MaterialsView.vue"), meta: { title: "文献与资料", fixedLayout: true } },
    { path: "/workflow/workspace", component: () => import("./views/workflow/WorkspaceView.vue"), meta: { title: "章节写作", fixedLayout: true } },
    { path: "/workflow/finalize", component: () => import("./views/workflow/FinalizeView.vue"), meta: { title: "统稿定稿", fixedLayout: true } },
    // 2026-09-26 新增: 投稿与要件 —— 五项投稿声明（作者贡献/基金/利益冲突/致谢/数据可得性）。
    // **不进进度条**：它是"定稿之后、投出去之前"的事务，不是研究流程的一步。
    // 批 6 的返修也落在这个区里（投稿相关的事不必两处找）。
    { path: "/workflow/submission", component: () => import("./views/workflow/SubmissionView.vue"), meta: { title: "投稿与要件", fixedLayout: true } },
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
