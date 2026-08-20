// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// skillify.ts — GBrain Skillify 机制：把重复成功的工作流固化为可复用 skill
// 输入：工作流描述（名称/触发场景/步骤/checklist/反触发）
// 输出：生成符合用户规范的 ~/.claude/skills/<name>/SKILL.md，原子写入
//
// 用法:
//   npx tsx scripts/skillify.ts --name my-flow --title "我的工作流" \
//     --triggers "场景A,场景B" --notTriggers "纯编程" \
//     --description "一句话描述" --steps "步骤1|步骤2|步骤3" \
//     --checklist "检查项1|检查项2"
// 或:
//   npx tsx scripts/skillify.ts --file flow.json   (json: {name,title,triggers,notTriggers,description,steps[],checklist[],recipes?})

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface SkillifyInput {
  name: string;
  title: string;
  description: string;
  triggers: string[];
  notTriggers: string[];
  steps: string[];
  checklist: string[];
  recipes?: string[];
}

function parseArgs(argv: string[]): Partial<SkillifyInput> | null {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1] ?? "";
      i += 1;
    }
  }
  if (args.file) {
    const raw = fs.readFileSync(path.resolve(args.file), "utf-8");
    const data = JSON.parse(raw);
    return {
      name: data.name,
      title: data.title,
      description: data.description,
      triggers: data.triggers ?? [],
      notTriggers: data.notTriggers ?? [],
      steps: data.steps ?? [],
      checklist: data.checklist ?? [],
      recipes: data.recipes
    };
  }
  if (!args.name) return null;
  return {
    name: args.name,
    title: args.title ?? args.name,
    description: args.description ?? "",
    triggers: (args.triggers ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    notTriggers: (args.notTriggers ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    steps: (args.steps ?? "").split("|").map((s) => s.trim()).filter(Boolean),
    checklist: (args.checklist ?? "").split("|").map((s) => s.trim()).filter(Boolean)
  };
}

function buildSkillMd(input: SkillifyInput): string {
  const now = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${input.name}`);
  lines.push(`description: "${input.description} (Skillify 固化 ${now})"`);
  if (input.triggers.length > 0) {
    lines.push(`triggers: [${input.triggers.join(", ")}]`);
  }
  if (input.notTriggers.length > 0) {
    lines.push(`notTriggers: [${input.notTriggers.join(", ")}]`);
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${input.title}（Skillify 固化技能）`);
  lines.push("");
  lines.push(`> **Skillify**: ${now} 由 SAG 记录的成功工作流固化生成。`);
  lines.push("");
  lines.push("## 何时使用");
  lines.push("");
  lines.push(`- ${input.description || "（无描述）"}`);
  lines.push("");
  lines.push("## 执行步骤");
  lines.push("");
  input.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`);
  });
  lines.push("");
  if (input.recipes && input.recipes.length > 0) {
    lines.push("## Recipes");
    lines.push("");
    input.recipes.forEach((recipe) => {
      lines.push(`- ${recipe}`);
    });
    lines.push("");
  }
  lines.push("## Checklist（Skillify 固化）");
  lines.push("");
  input.checklist.forEach((item) => {
    lines.push(`- [ ] ${item}`);
  });
  lines.push("");
  lines.push("## 备注");
  lines.push("");
  lines.push("- 本 skill 由 Skillify 机制自动生成，可人工修改完善。");
  lines.push("- 遵守学术诚信：产出必须人工核实，引用须真实。");
  return lines.join("\n");
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed?.name || !parsed.steps || parsed.steps.length === 0) {
    console.error("用法错误：需要 --name 和至少一个 --steps。示例见文件头注释。");
    process.exit(1);
  }
  const input = parsed as SkillifyInput;

  const skillsDir = path.join(os.homedir(), ".claude", "skills");
  const targetDir = path.join(skillsDir, input.name);
  const skillMdPath = path.join(targetDir, "SKILL.md");

  // 已存在则拒绝覆盖（防止误覆盖真实 skill）
  if (fs.existsSync(skillMdPath)) {
    console.error(`SKILL.md 已存在: ${skillMdPath}，拒绝覆盖。如需更新请手动编辑。`);
    process.exit(2);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const content = buildSkillMd(input);
  fs.writeFileSync(skillMdPath, content, "utf-8");
  console.log(`✅ Skillify 生成成功: ${skillMdPath}`);
  console.log(`   triggers: ${input.triggers.join(", ") || "(无)"}`);
  console.log(`   steps: ${input.steps.length} 步, checklist: ${input.checklist.length} 项`);
}

main();
