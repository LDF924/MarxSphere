// plotly.js-dist-min 无类型声明 — 统一分析台(StatsMethodWorkspace)动态 import 用
declare module "plotly.js-dist-min" {
  const Plotly: {
    newPlot(el: HTMLElement, data: unknown, layout: unknown, cfg?: Record<string, unknown>): Promise<unknown>;
    react(el: HTMLElement, data: unknown, layout: unknown, cfg?: Record<string, unknown>): Promise<unknown>;
  };
  export default Plotly;
}
