import { proposeSkill, validateSkill } from "../src/services/agent-skill-distill.js";
const s = await proposeSkill("smoke-prop-1", "论文深度问答冒烟", "【高频重复任务】论文深度问答 — 近期出现 5 次值得沉淀\n【最近一次执行策略】检索原文→定位→逐句推理→带引文回答\n【质量】质量分 0.85 / 成功", ["sag_reason"]);
console.log("proposeSkill:", s ? `OK id=${s.id} name=${s.name}` : "NULL");
if (s) {
  const v = await validateSkill(s.id, 1);
  console.log("validate:", JSON.stringify(v));
}
