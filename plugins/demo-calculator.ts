// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// 示例插件: 计算器工具（证明 A1 插件热加载工作）
// 放任意 .ts 文件到 plugins/ 目录 → 自动加载为 Agent 工具
export const tools = [
  {
    name: "calc", label: "计算器", risk: "safe",
    description: "简单数学计算（插件示例: 证明热加载工作）",
    params: { expr: { type: "string", required: true, desc: "表达式如 2+3*4" } },
    run: async (a: Record<string, unknown>) => {
      const expr = String(a.expr || "").replace(/[^0-9+\-*/().\s]/g, "");
      if (!expr) return "（表达式非法）";
      try {
        // eslint-disable-next-line no-new-func
        const result = new Function(`return (${expr})`)();
        return `【计算器】${expr} = ${result}`;
      } catch {
        return "（计算失败）";
      }
    },
  },
];
