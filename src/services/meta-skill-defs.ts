// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// src/services/meta-skill-defs.ts — V404-4: MetaSkill 试点场景定义(声明式 DAG)
// 试点: 文献综述生成(S51 综述能力改写为声明式步骤 DAG)
//   输入主题 → 澄清范围(user_input) → 检索素材(agent) → 按模板生成综述(llm_chat)
//   → 引用检查门(llm_gate, 失败 on_failure 重写) → 交付
// 编排由运行时强制(拓扑序/门控/备胎), 不是模型自律 — 对齐 OpenSquilla meta-skills
import type { MetaSkillDef } from "./meta-skill-runtime.js";

export const META_SKILLS: MetaSkillDef[] = [
  {
    id: "lit_review_dag",
    name: "文献综述生成(DAG 试点)",
    description: "高质量文献综述: 澄清范围 → 检索 → 综述生成 → 引用检查门 → 交付",
    trigger: "生成文献综述/写综述",
    final_text_mode: "raw",
    steps: [
      {
        id: "clarify",
        kind: "user_input",
        label: "澄清综述范围",
        clarify: {
          intro: "生成综述前先确认范围(避免泛泛而谈):",
          fields: [
            { name: "topic", type: "string", required: true, prompt: "综述主题(研究问题, 如: 资本下乡对村级治理的影响)" },
            { name: "years", type: "string", prompt: "文献年限(默认近5年)" },
            { name: "focus", type: "string", prompt: "侧重点(机制/争论/方法, 默认学术脉络)" },
          ],
        },
      },
      {
        id: "retrieve",
        kind: "agent",
        label: "检索文献素材",
        depends_on: ["clarify"],
        with: { topic: "{{user.topic}}", topK: 8 },
      },
      {
        id: "draft",
        kind: "llm_chat",
        label: "按模板生成综述",
        depends_on: ["retrieve"],
        with: {
          system: "你是马克思主义理论与政治经济学领域的文献综述专家。按学术综述结构模板组织: 研究缘起 → 发展脉络 → 学派分歧 → 研究共识 → 现存不足。拒绝观点堆砌, 突出学术脉络与争论焦点。",
          task: "综述主题: {{user.topic}}\n文献年限: {{user.years || '近5年'}}\n侧重: {{user.focus || '学术脉络'}}\n\n检索素材:\n{{outputs.retrieve | slice(6000)}}\n\n请生成综述初稿(1500-2500字), 每个观点尽量带作者/年份标注。",
          maxTokens: 4000,
        },
      },
      {
        id: "citation_gate",
        kind: "llm_gate",
        label: "引用检查门",
        depends_on: ["draft"],
        with: {
          criteria: "1) 每个关键论断都有作者或年份标注(非空泛陈述); 2) 不含无法核实的具体引文页码; 3) 结构含脉络而非堆砌。",
          text: "{{outputs.draft}}",
          on: "draft",
        },
        on_failure: "draft_retry",
      },
      {
        id: "draft_retry",
        kind: "llm_chat",
        label: "综述返工(补引用标注)",
        with: {
          system: "你是文献综述专家。上一稿引用标注不足, 请重写: 给每个论断补上(作者, 年份)式标注; 无法确定出处的论断改为综述式转述, 不编造引文。",
          task: "主题: {{user.topic}}\n\n上一稿:\n{{outputs.draft | slice(6000)}}\n\n重写要求: 保持结构, 补全引用标注。",
          maxTokens: 4000,
        },
      },
    ],
  },
];

export function getMetaSkill(id: string): MetaSkillDef | undefined {
  return META_SKILLS.find((s) => s.id === id);
}

// ═══ V404-10: 动态 DAG 合并 — 静态代码定义 + DB 动态定义(人工审 accept 后注册) ═══
/**
 * 加载全部可用 MetaSkill(静态 META_SKILLS + agent_meta_dags 表 enabled 的动态定义)
 * 失败(表不存在等)降级为静态列表 — 不阻塞运行时
 */
export async function loadAllMetaSkills(): Promise<MetaSkillDef[]> {
  const all = [...META_SKILLS];
  try {
    const { pool } = await import("../db/pool.js");
    const r = await pool.query("select id, dag_json from agent_meta_dags where enabled = true order by created_at desc limit 20");
    for (const row of r.rows) {
      try {
        const dag = typeof row.dag_json === "string" ? JSON.parse(row.dag_json) : row.dag_json;
        if (dag && Array.isArray(dag.steps) && dag.steps.length >= 2 && !all.some((x) => x.id === dag.id)) {
          all.push({ id: String(dag.id), name: String(dag.name || dag.id), description: String(dag.description || ""), trigger: dag.trigger, steps: dag.steps });
        }
      } catch { /* 单条坏 DAG 跳过 */ }
    }
  } catch { /* 表不存在/DB 不可用 → 静态 */ }
  return all;
}

/** 按 id 取(静态优先, 动态兜底) — async 版本供 API/运行时使用 */
export async function getMetaSkillAsync(id: string): Promise<MetaSkillDef | undefined> {
  const all = await loadAllMetaSkills();
  return all.find((s) => s.id === id);
}
