// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// econometricSchema.ts — 计量因果 19 法参数 schema(2026-09-09 统一分析台融合)
// 从 EmpiricalResearchPanel 各方法专属 JSX 表单提取参数键, 供统一工作区渲染深度配置
export interface EcoField {
  key: string;
  label: string;
  /** col=单列下拉 | cols=逗号分隔多列文本框 | num=数值输入 | text=文本 | json=JSON 文本域 | select=固定选项 */
  kind: "col" | "cols" | "num" | "text" | "json" | "select";
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  hint?: string;
}

export interface EcoMethodSchema {
  fields: EcoField[];
  extra?: Array<{ key: string; label: string }>;
}

/** 各计量法参数定义(键与 EmpiricalResearchPanel config JSX 完全一致) */
export const ECO_SCHEMAS: Record<string, EcoMethodSchema> = {
  did: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "treat", label: "处理变量 treat", kind: "col" },
    { key: "time", label: "时间列(绝对年份)", kind: "col" },
    { key: "id", label: "个体 id (可选)", kind: "col" },
    { key: "cluster", label: "聚类列 (可选)", kind: "col" },
  ]},
  did_twfe: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "treat", label: "处理变量 treat", kind: "col" },
    { key: "time", label: "时间列(绝对年份)", kind: "col" },
    { key: "id", label: "个体 id (可选)", kind: "col" },
    { key: "cluster", label: "聚类列 (可选)", kind: "col" },
  ]},
  event_study: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "unit", label: "个体 id", kind: "col" },
    { key: "time", label: "时间列", kind: "col" },
    { key: "treat_time", label: "处理时间列(未处理=0/超范围)", kind: "col" },
  ], extra: [{ key: "_note", label: "基期 t=-1, 窗口 -4 到 +4, 自动平行趋势检验" }]},
  mediation: { fields: [
    { key: "x", label: "X (自变量)", kind: "col" },
    { key: "y", label: "Y (因变量)", kind: "col" },
    { key: "m", label: "M (中介变量)", kind: "col" },
    { key: "center", label: "中心化处理", kind: "select", options: [{ value: "1", label: "是" }, { value: "0", label: "否" }] },
  ]},
  moderation: { fields: [
    { key: "x", label: "X (自变量)", kind: "col" },
    { key: "y", label: "Y (因变量)", kind: "col" },
    { key: "m", label: "W (调节变量)", kind: "col" },
    { key: "center", label: "中心化处理", kind: "select", options: [{ value: "1", label: "是" }, { value: "0", label: "否" }] },
  ]},
  iv: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "endog", label: "内生变量", kind: "col" },
    { key: "instruments", label: "工具变量 (逗号分隔多列)", kind: "cols", placeholder: "如 z1, z2" },
    { key: "xs", label: "控制变量 xs (可选)", kind: "cols", placeholder: "如 x1, x2" },
  ]},
  rdd: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "running", label: "运行变量 (断点)", kind: "col" },
    { key: "cutoff", label: "断点值", kind: "num" },
  ]},
  panel_fe: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "id", label: "个体 id", kind: "col" },
    { key: "time", label: "时间列", kind: "col" },
    { key: "xs", label: "自变量 xs", kind: "cols", placeholder: "如 x1, x2" },
  ]},
  psm: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "treat", label: "处理变量", kind: "col" },
    { key: "xs", label: "协变量 xs", kind: "cols", placeholder: "如 x1, x2" },
  ]},
  scm: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "unit", label: "个体 id", kind: "col" },
    { key: "time", label: "时间列", kind: "col" },
    { key: "treated_unit", label: "处理单元值", kind: "num", placeholder: "如 0" },
    { key: "treatment_time", label: "处理时间 (年份)", kind: "num", placeholder: "如 2016" },
  ]},
  ols: { fields: [
    { key: "y", label: "结果变量 y", kind: "col" },
    { key: "xs", label: "自变量 xs (逗号分隔)", kind: "cols", placeholder: "如 treat, post" },
  ]},
  logit: { fields: [
    { key: "y", label: "因变量 (0/1)", kind: "col" },
    { key: "link", label: "链接函数", kind: "select", options: [{ value: "logit", label: "Logit" }, { value: "probit", label: "Probit" }] },
    { key: "xs", label: "自变量 xs", kind: "cols", placeholder: "如 edu, area" },
  ]},
  ologit: { fields: [
    { key: "y", label: "因变量 (有序 1-5)", kind: "col" },
    { key: "xs", label: "自变量 xs", kind: "cols", placeholder: "如 edu, area" },
  ]},
  mnl: { fields: [
    { key: "y", label: "因变量 (多分类)", kind: "col" },
    { key: "xs", label: "自变量 xs", kind: "cols", placeholder: "如 edu, area" },
  ]},
  crosstab: { fields: [
    { key: "row", label: "行变量", kind: "col" },
    { key: "col", label: "列变量", kind: "col" },
  ], extra: [{ key: "_note", label: "输出: 交叉表 + 行百分比 + 卡方检验 + Cramér's V" }]},
  genvars: { fields: [
    { key: "formulas", label: "公式 JSON", kind: "json", placeholder: '[{"name":"rate","expr":"out/own"}]' },
  ], extra: [{ key: "_note", label: "支持 + - * / () 与已有列; 生成新列供后续分析" }]},
  filter: { fields: [
    { key: "conditions", label: "条件 JSON", kind: "json", placeholder: '[{"col":"identity","op":"==","value":2}]' },
  ], extra: [{ key: "_note", label: "支持 == != > >= < <= in; 输出筛选后描述统计" }]},
  descriptive: { fields: [], extra: [{ key: "_note", label: "统计全部数值列: 均值/标准差/N/Min/Max" }]},
  meta_analysis: { fields: [
    { key: "yiCol", label: "效应量列 yi", kind: "col" },
    { key: "viCol", label: "方差列 vi", kind: "col" },
    { key: "clusterCol", label: "独立群列 cluster (可选)", kind: "col" },
    { key: "model", label: "模型", kind: "select", options: [{ value: "random", label: "随机效应 (默认)" }, { value: "common", label: "固定效应" }] },
    { key: "test", label: "推断方法", kind: "select", options: [{ value: "knha", label: "Hartung-Knapp (t)" }, { value: "z", label: "正态近似 (z)" }] },
  ]},
};
