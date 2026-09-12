/**
 * StatisticsView 17 方法注册表 + 参数 schema — 还原自闭源 StatisticsView-C1S4N5xA.js
 * (A/H/we/Le 数组 + 17 模板 L617-1216 + 提交组装 Je() L1318-1439)
 * 每方法: key/local 默认/校验/提交组装; ParamField.vue 按 schema 渲染表单
 */
export interface VarDef {
  name: string;
  type: string; // scale | nominal | unknown
}

export interface ParamFieldDef {
  kind: "checkbox" | "radio" | "select" | "number" | "group" | "text" | "info";
  key: string;
  label: string;
  options?: Array<{ value: string | number; label: string }>;
  placeholder?: string;
  min?: number;
  max?: number;
  default?: unknown;
  groupSize?: number;
  /** select/radio 特殊: 从上传变量里挑(需变量列表) */
  fromVars?: { filter?: "scale" | "nominal" | "all"; multi?: boolean; max?: number; label?: string };
  note?: string;
}

export interface MethodDef {
  id: string;
  name: string;
  category: string;
  desc: string;
  needVars: boolean;
  needData: boolean;
  varsFilter?: "scale" | "nominal" | "all";
  defaults: Record<string, unknown>;
  fields: ParamFieldDef[];
  build: (p: Record<string, unknown>, vars: string[], fileId: string) => Record<string, unknown>;
  validate: (p: Record<string, unknown>, vars: string[]) => string | null;
}

const need = (msg: string) => (_p: Record<string, unknown>, vars: string[]) => (!vars.length ? msg : null);
const noValidate: (p: Record<string, unknown>, vars: string[]) => string | null = () => null;

export const METHODS: MethodDef[] = [
  // ═══ 数据基础 ═══
  {
    id: "descriptive", name: "描述统计", category: "数据基础",
    desc: "均值/中位数/标准差/极值/四分位/偏度/峰度, 可附箱线图与直方图",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: { mean: 1, median: 1, std: 1, minmax: 1, quartiles: 1, skew: 0, kurt: 0, histogram: 1 },
    fields: [
      { kind: "info", key: "_i", label: "选择数值变量后, 勾选要输出的统计量:" },
      { kind: "checkbox", key: "mean", label: "均值", default: 1 },
      { kind: "checkbox", key: "median", label: "中位数", default: 1 },
      { kind: "checkbox", key: "std", label: "标准差", default: 1 },
      { kind: "checkbox", key: "minmax", label: "最小值 / 最大值", default: 1 },
      { kind: "checkbox", key: "quartiles", label: "四分位数 Q1/Q3", default: 1 },
      { kind: "checkbox", key: "skew", label: "偏度", default: 0 },
      { kind: "checkbox", key: "kurt", label: "峰度", default: 0 },
      { kind: "info", key: "_g", label: "图表:" },
      { kind: "checkbox", key: "histogram", label: "直方图", default: 1 }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "descriptive", variables: vars, options: p }),
    validate: need("请至少选择一个变量")
  },
  {
    id: "frequency", name: "频数分析", category: "数据基础",
    desc: "分类变量频数分布表(取值/频数/百分比)",
    needVars: false, needData: true, varsFilter: "nominal",
    defaults: {},
    fields: [{ kind: "info", key: "_i", label: "对所选分类变量输出频数分布(不选时自动取全部分类列)" }],
    build: (p, vars, fileId) => ({ fileId, tool: "frequency", variables: vars }),
    validate: noValidate
  },
  {
    id: "classify", name: "分类汇总", category: "数据基础",
    desc: "按分组变量汇总描述统计(分组可不选=整体)",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: { groupVar: "" },
    fields: [
      { kind: "select", key: "groupVar", label: "分组变量(可选)", fromVars: { filter: "nominal", multi: false }, default: "" }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "classify", variables: vars, groupVar: p.groupVar || undefined }),
    validate: need("请至少选择一个数值变量")
  },
  {
    id: "transform", name: "数据转换", category: "数据基础",
    desc: "生成 z-score / min-max / log / 秩 / 平方根 新列",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: { transforms: ["z-score"] },
    fields: [
      { kind: "checkbox", key: "transforms", label: "转换方式(可多选)", options: [
        { value: "z-score", label: "z-score 标准化" }, { value: "min-max", label: "min-max 归一化" },
        { value: "log", label: "自然对数 log" }, { value: "rank", label: "秩转换 rank" }, { value: "sqrt", label: "平方根 sqrt" }
      ], default: ["z-score"] }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "transform", variables: vars, transforms: p.transforms }),
    validate: (_p, vars) => (!vars.length ? "请至少选择一个变量" : null)
  },
  {
    id: "filter", name: "数据筛选", category: "数据基础",
    desc: "按条件筛选生成子样本(运算关系 AND/OR)",
    needVars: false, needData: true,
    defaults: { conditions: [{ variable: "", operator: ">=", value: "" }], logic: "and" },
    fields: [
      { kind: "info", key: "_i", label: "条件行: 变量 运算符 值(≥ 追加一行条件)" }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "filter", conditions: p.conditions, logic: p.logic }),
    validate: (p) => {
      const conds = (p.conditions as Array<{ variable: string; value: string }>) ?? [];
      if (!conds.length || conds.some((c) => !c.variable || c.value === "")) return "请补全筛选条件(变量与值)";
      return null;
    }
  },
  // ═══ 推断统计 ═══
  {
    id: "t-test", name: "t 检验", category: "推断统计",
    desc: "单样本(检验值)/独立样本(分组)/配对(两两) t 检验",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: { testType: "one_sample", testValue: 0, groupVar: "" },
    fields: [
      { kind: "radio", key: "testType", label: "检验类型", options: [
        { value: "one_sample", label: "单样本 t 检验" }, { value: "independent", label: "独立样本 t 检验" },
        { value: "paired", label: "配对 t 检验(选 ≥2 变量按顺序配对)" }
      ], default: "one_sample" },
      { kind: "number", key: "testValue", label: "检验值(单样本)", default: 0 },
      { kind: "select", key: "groupVar", label: "分组变量(独立样本)", fromVars: { filter: "nominal", multi: false }, default: "" }
    ],
    build: (p, vars, fileId) => {
      if (p.testType === "one_sample") return { fileId, tool: "t-test", variables: vars, testValue: Number(p.testValue ?? 0) };
      if (p.testType === "independent") return { fileId, tool: "t-test", dependentVar: vars[0], groupVar: p.groupVar };
      return { fileId, tool: "t-test", pairedVars: vars };
    },
    validate: (p, vars) => {
      if (!vars.length) return "请选择变量";
      if (p.testType === "independent" && !p.groupVar) return "请选择分组变量";
      if (p.testType === "paired" && vars.length < 2) return "配对检验需至少 2 个变量";
      return null;
    }
  },
  {
    id: "anova", name: "单因素 ANOVA", category: "推断统计",
    desc: "分组均值差异检验(分组变量 + ≥1 数值因变量)",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: { groupVar: "" },
    fields: [
      { kind: "select", key: "groupVar", label: "分组变量", fromVars: { filter: "nominal", multi: false }, default: "" }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "anova", variables: vars, groupVar: p.groupVar }),
    validate: (p, vars) => (!p.groupVar ? "请选择分组变量" : vars.length < 1 ? "请至少选择一个数值变量" : null)
  },
  {
    id: "multivariate-anova", name: "多因素 ANOVA", category: "推断统计",
    desc: "多因素方差分析(因变量 + 2-3 个因素, 含交互)",
    needVars: false, needData: true,
    defaults: { dependentVar: "", factors: [], postHocMethod: "tukey" },
    fields: [
      { kind: "select", key: "dependentVar", label: "因变量", fromVars: { filter: "scale", multi: false }, default: "" },
      { kind: "select", key: "factors", label: "因素(2-3 个)", fromVars: { filter: "nominal", multi: true, max: 3 }, default: [] },
      { kind: "radio", key: "postHocMethod", label: "事后检验", options: [{ value: "tukey", label: "Tukey HSD" }, { value: "bonferroni", label: "Bonferroni" }], default: "tukey" }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "multivariate-anova", dependentVar: p.dependentVar, factors: p.factors, postHocMethod: p.postHocMethod }),
    validate: (p) => (!p.dependentVar ? "请选择因变量" : (p.factors as string[]).length < 2 ? "请至少选择 2 个因素" : null)
  },
  {
    id: "correlation", name: "相关分析", category: "推断统计",
    desc: "Pearson/Spearman/Kendall 相关矩阵 + 显著性 + 热图",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: { method: "pearson" },
    fields: [
      { kind: "radio", key: "method", label: "相关系数", options: [
        { value: "pearson", label: "Pearson" }, { value: "spearman", label: "Spearman" }, { value: "kendall", label: "Kendall" }
      ], default: "pearson" }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "correlation", variables: vars, method: p.method }),
    validate: (_p, vars) => (vars.length < 2 ? "请至少选择 2 个变量" : null)
  },
  {
    id: "crosstab", name: "交叉表·卡方", category: "推断统计",
    desc: "两分类变量交叉表 + 卡方检验 + Cramér's V",
    needVars: false, needData: true,
    defaults: { rowVar: "", colVar: "" },
    fields: [
      { kind: "select", key: "rowVar", label: "行变量", fromVars: { filter: "nominal", multi: false }, default: "" },
      { kind: "select", key: "colVar", label: "列变量", fromVars: { filter: "nominal", multi: false }, default: "" }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "crosstab", rowVar: p.rowVar, colVar: p.colVar }),
    validate: (p) => (!p.rowVar || !p.colVar ? "请选择行变量与列变量" : p.rowVar === p.colVar ? "行/列变量不能相同" : null)
  },
  {
    id: "nonparametric", name: "非参数检验", category: "推断统计",
    desc: "Mann-Whitney U(分组)/Wilcoxon(配对)/Kruskal-Wallis",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: { testType: "mann-whitney", groupVar: "" },
    fields: [
      { kind: "radio", key: "testType", label: "检验类型", options: [
        { value: "mann-whitney", label: "Mann-Whitney U(独立)" }, { value: "wilcoxon", label: "Wilcoxon(配对)" },
        { value: "kruskal", label: "Kruskal-Wallis(多组)" }
      ], default: "mann-whitney" },
      { kind: "select", key: "groupVar", label: "分组变量(M-W/Kruskal)", fromVars: { filter: "nominal", multi: false }, default: "" }
    ],
    build: (p, vars, fileId) => {
      const list = p.testType === "wilcoxon" ? vars : vars.slice(0, p.testType === "kruskal" ? vars.length : vars.length);
      const body: Record<string, unknown> = { fileId, tool: "nonparametric", variables: list, testType: p.testType };
      if (p.groupVar) body.groupVar = p.groupVar;
      return body;
    },
    validate: (p, vars) => {
      if (!vars.length) return "请选择变量";
      if ((p.testType === "mann-whitney" || p.testType === "kruskal") && !p.groupVar) return "请选择分组变量";
      if (p.testType === "wilcoxon" && vars.length < 2) return "配对检验需至少 2 个变量";
      return null;
    }
  },
  {
    id: "normality", name: "正态性检验", category: "推断统计",
    desc: "Shapiro-Wilk + Kolmogorov-Smirnov 正态性检验",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: {},
    fields: [{ kind: "info", key: "_i", label: "对每个所选变量输出 Shapiro-Wilk 与 K-S 检验" }],
    build: (p, vars, fileId) => ({ fileId, tool: "normality", variables: vars }),
    validate: need("请至少选择一个变量")
  },
  // ═══ 回归建模 ═══
  {
    id: "regression", name: "OLS 回归", category: "回归建模",
    desc: "多元线性回归: 系数/标准误/t/p/95%CI + R² + 系数图",
    needVars: false, needData: true,
    defaults: { dependentVar: "", independentVars: [] },
    fields: [
      { kind: "select", key: "dependentVar", label: "因变量 Y", fromVars: { filter: "scale", multi: false }, default: "" },
      { kind: "select", key: "independentVars", label: "自变量 X(可多选)", fromVars: { filter: "scale", multi: true }, default: [] }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "regression", dependentVar: p.dependentVar, independentVars: p.independentVars }),
    validate: (p) => (!p.dependentVar ? "请选择因变量" : !(p.independentVars as string[]).length ? "请至少选择一个自变量" : null)
  },
  {
    id: "logistic-regression", name: "Logistic 回归", category: "回归建模",
    desc: "二分类 Logistic 回归(因变量须 0/1 编码), 输出优势比 OR",
    needVars: false, needData: true,
    defaults: { dependentVar: "", independentVars: [], showOddsRatios: 1 },
    fields: [
      { kind: "select", key: "dependentVar", label: "因变量(0/1)", fromVars: { filter: "all", multi: false }, default: "" },
      { kind: "select", key: "independentVars", label: "自变量 X(可多选)", fromVars: { filter: "scale", multi: true }, default: [] },
      { kind: "checkbox", key: "showOddsRatios", label: "输出优势比 OR", default: 1 },
      { kind: "info", key: "_note", label: "提示: 因变量须为 0/1 二分类编码" }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "logistic-regression", dependentVar: p.dependentVar, independentVars: p.independentVars, showOddsRatios: p.showOddsRatios }),
    validate: (p) => (!p.dependentVar ? "请选择因变量" : !(p.independentVars as string[]).length ? "请至少选择一个自变量" : null)
  },
  // ═══ 信效度&高级 ═══
  {
    id: "reliability", name: "信度 α", category: "信效度&高级",
    desc: "Cronbach α 信度分析(选取量表题项) + 删除项后 α",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: {},
    fields: [{ kind: "info", key: "_i", label: "选取同一量表的题项变量(≥2), 计算 Cronbach α" }],
    build: (p, vars, fileId) => ({ fileId, tool: "reliability", variables: vars }),
    validate: (_p, vars) => (vars.length < 2 ? "信度分析需至少 2 个题项变量" : null)
  },
  {
    id: "efa", name: "因子分析", category: "信效度&高级",
    desc: "探索性因子分析: 载荷矩阵/特征值/解释方差",
    needVars: true, needData: true, varsFilter: "scale",
    defaults: { extraction: "principal", rotation: "varimax", nFactors: "" },
    fields: [
      { kind: "radio", key: "extraction", label: "抽取方法", options: [{ value: "principal", label: "主成分" }, { value: "principal_axis", label: "主轴因子" }], default: "principal" },
      { kind: "radio", key: "rotation", label: "旋转", options: [{ value: "varimax", label: "Varimax" }, { value: "promax", label: "Promax" }, { value: "oblimin", label: "Oblimin" }], default: "varimax" },
      { kind: "number", key: "nFactors", label: "因子数(留空=自动)", default: "" }
    ],
    build: (p, vars, fileId) => ({ fileId, tool: "efa", variables: vars, extraction: p.extraction, rotation: p.rotation, nFactors: p.nFactors === "" || p.nFactors === null ? undefined : Number(p.nFactors) }),
    validate: (_p, vars) => (vars.length < 3 ? "因子分析需至少 3 个变量" : null)
  },
  {
    id: "mediation-moderation", name: "中介·调节", category: "信效度&高级",
    desc: "中介效应(X→M→Y 三步法+Sobel) / 调节效应(X*W 交互)",
    needVars: false, needData: true,
    defaults: { analysisType: "mediation", xVar: "", yVar: "", mVar: "", wVar: "", method: "bootstrap", bootstrapSamples: 5000, centering: "mean" },
    fields: [
      { kind: "radio", key: "analysisType", label: "分析类型", options: [{ value: "mediation", label: "中介效应" }, { value: "moderation", label: "调节效应" }], default: "mediation" },
      { kind: "select", key: "xVar", label: "自变量 X", fromVars: { filter: "scale", multi: false }, default: "" },
      { kind: "select", key: "yVar", label: "因变量 Y", fromVars: { filter: "scale", multi: false }, default: "" },
      { kind: "select", key: "mVar", label: "中介变量 M(中介)", fromVars: { filter: "scale", multi: false }, default: "" },
      { kind: "select", key: "wVar", label: "调节变量 W(调节)", fromVars: { filter: "scale", multi: false }, default: "" },
      { kind: "radio", key: "centering", label: "中心化", options: [{ value: "mean", label: "均值中心化" }, { value: "none", label: "不中心化" }], default: "mean" }
    ],
    build: (p, vars, fileId) => {
      const body: Record<string, unknown> = { fileId, tool: "mediation-moderation", analysisType: p.analysisType, xVar: p.xVar, yVar: p.yVar, centering: p.centering };
      if (p.analysisType === "mediation") body.mVar = p.mVar || undefined;
      else body.wVar = p.wVar || undefined;
      return body;
    },
    validate: (p) => {
      if (!p.xVar || !p.yVar) return "请选择自变量 X 与因变量 Y";
      if (p.analysisType === "mediation" && !p.mVar) return "中介分析需选择中介变量 M";
      if (p.analysisType === "moderation" && !p.wVar) return "调节分析需选择调节变量 W";
      return null;
    }
  }
];

export const methodById = (id: string): MethodDef | null => METHODS.find((m) => m.id === id) ?? null;

export const METHOD_CATEGORIES = ["数据基础", "推断统计", "回归建模", "信效度&高级"] as const;

export const groupedMethods = (): Record<string, MethodDef[]> => ({
  "数据基础": METHODS.filter((m) => m.category === "数据基础"),
  "推断统计": METHODS.filter((m) => m.category === "推断统计"),
  "回归建模": METHODS.filter((m) => m.category === "回归建模"),
  "信效度&高级": METHODS.filter((m) => m.category === "信效度&高级")
});

/** 变量类型归一(闭源 ct() L1274-1290: categorical/binary/nominal→nominal; continuous/numeric/scale→scale) */
export function normalizeVarType(t: string): string {
  const s = String(t ?? "").toLowerCase();
  if (["categorical", "binary", "nominal", "category", "object", "string", "text", "bool"].includes(s)) return "nominal";
  if (["continuous", "numeric", "scale", "float", "int", "number", "integer"].includes(s)) return "scale";
  return "unknown";
}

export const varTypeMeta = (t: string): { label: string; cls: string } => {
  if (t === "scale") return { label: "数值", cls: "type-badge-sm scale" };
  if (t === "nominal") return { label: "分类", cls: "type-badge-sm nominal" };
  return { label: "未知", cls: "" };
};

export function isIdColumn(name: string, type: string): boolean {
  return type === "id" || /^(id|uuid|identifier|case[_-]?id|subject[_-]?id)$/i.test(name);
}

/** 数值格式(闭源 Oe(): |x|≥1000 或 <0.001 → toExponential(3); <0.01 → 4 位; 整数原样; 否则 3 位) */
export function fmtCell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (Number.isNaN(n)) return String(v);
  if (!Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  if (abs >= 1000 || (abs > 0 && abs < 0.001)) return n.toExponential(3);
  if (abs > 0 && abs < 0.01) return n.toFixed(4);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}

export const HEALTH_LABELS: Record<string, string> = {
  connected: "后端已连接", disconnected: "后端未启动", checking: "检测中…", unknown: "未知"
};
