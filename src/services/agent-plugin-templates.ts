// agent-plugin-templates.ts — 架构#7: 插件模板库
// 预置插件模板: 一键安装到 plugins/ 目录（生成 .ts 文件, 热加载生效）
import { promises as fsP } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PluginTemplate {
  id: string;
  name: string;
  desc: string;
  /** 生成的插件文件内容（tools 数组） */
  content: string;
}

/** 插件模板库（可扩展: 数据可视化/文献管理/翻译） */
export const PLUGIN_TEMPLATES: PluginTemplate[] = [
  {
    id: "viz", name: "数据可视化", desc: "将数据渲染为 ASCII 图表（柱状/折线, 沙箱内零依赖）",
    content: `// 数据可视化插件（模板安装）
export const tools = [
  {
    name: "ascii_chart", label: "ASCII图表", risk: "safe",
    description: "将数值数组渲染为 ASCII 柱状/折线图（零依赖, 沙箱内可用）",
    params: {
      data: { type: "string", required: true, desc: "数值数组 JSON, 如 [3,7,2,9,5]" },
      labels: { type: "string", desc: "标签数组 JSON, 可选" },
      width: { type: "number", desc: "图表宽度(默认30)" },
    },
    run: async (a) => {
      try {
        const data = JSON.parse(String(a.data || "[]"));
        const labels = a.labels ? JSON.parse(String(a.labels)) : [];
        const width = Math.min(Math.max(Number(a.width) || 30, 10), 60);
        if (!Array.isArray(data) || data.some((d) => typeof d !== "number")) return "（data 需为数值数组）";
        const max = Math.max(...data, 1);
        const lines = data.map((v, i) => {
          const bar = "#".repeat(Math.max(1, Math.round(v / max * width)));
          return \`\${labels[i] ?? i}: \${bar} \${v}\`;
        });
        return ["【ASCII图表】", ...lines].join("\\n");
      } catch { return "（数据解析失败）"; }
    },
  },
];
`,
  },
  {
    id: "lit_tool", name: "文献管理", desc: "快速生成文献引用格式（GB/T 7714）",
    content: `// 文献管理插件（模板安装）
export const tools = [
  {
    name: "cite_format", label: "引文格式化", risk: "safe",
    description: "生成 GB/T 7714 格式文献引用",
    params: {
      author: { type: "string", required: true, desc: "作者" },
      year: { type: "string", required: true, desc: "年份" },
      title: { type: "string", required: true, desc: "标题" },
      journal: { type: "string", desc: "期刊/出处" },
      issue: { type: "string", desc: "期号/卷" },
      pages: { type: "string", desc: "页码" },
    },
    run: async (a) => {
      const author = String(a.author || "");
      const title = String(a.title || "");
      const journal = String(a.journal || "");
      const year = String(a.year || "");
      const issue = a.issue ? \`(\${a.issue})\` : "";
      const pages = a.pages ? \`:\${a.pages}\` : "";
      return \`\${author}.\${title}[\${journal ? "J" : "M"}]//\${journal}\${issue}. \${year}\${pages}.\`;
    },
  },
];
`,
  },
  {
    id: "translate", name: "翻译", desc: "中英互译（LLM, 学术语体）",
    content: `// 翻译插件（模板安装）
export const tools = [
  {
    name: "translate_text", label: "学术翻译", risk: "safe",
    description: "中英互译（学术语体, 术语保真）",
    params: {
      text: { type: "string", required: true, desc: "待翻译文本" },
      target: { type: "string", desc: "目标语言: en(默认)/zh" },
    },
    run: async (a) => {
      const text = String(a.text || "");
      const target = String(a.target || "en");
      const { callLlm } = await import("./src/ai/llm-common.js");
      const r = await callLlm({
        messages: [{ role: "user", content: \`将以下学术文本翻译为\${target === "zh" ? "中文" : "英文"}, 保持学术语体和术语准确:\\n\\n\${text.slice(0, 2000)}\` }],
        maxTokens: 1000,
      });
      return r?.text || "（翻译失败）";
    },
  },
];
`,
  },
];

/** 安装模板 → 生成插件文件到 plugins/ 目录
 * M2: 生成后立即校验签名 — 若配置了 AGENT_PLUGIN_SIGNATURES 且新文件不在
 * 白名单/哈希不匹配 → 删除并拒绝（防未签名插件生效） */
export async function installPluginTemplate(templateId: string): Promise<{ file: string; tools: number } | null> {
  const tpl = PLUGIN_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return null;
  try {
    const dir = process.env.AGENT_PLUGINS_DIR
      || path.join(process.env.SAG_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "plugins");
    await fsP.mkdir(dir, { recursive: true });
    const fileName = `${tpl.id}.ts`;
    const file = path.join(dir, fileName);
    await fsP.writeFile(file, tpl.content, "utf8");
    // M2: 签名校验（配置了白名单时, 新插件不在白名单 → 回滚删除）
    try {
      const { verifyPluginSignature } = await import("./agent-file-plugins.js");
      const sig = await verifyPluginSignature(fileName);
      if (!sig.ok) {
        await fsP.rm(file, { force: true }).catch(() => {});
        console.error(`[agent] M2 插件模板安装被签名拦截: ${sig.reason}`);
        return null;
      }
    } catch { /* 签名服务不可用 → 放行 */ }
    // 提取工具数（粗略: content 中 name: 出现次数）
    const tools = (tpl.content.match(/name: "/g) || []).length;
    return { file, tools };
  } catch { return null; }
}
