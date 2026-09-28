/**
 * tool-meta-coverage.test.ts — 前端**不许再持有工具清单**。
 *
 * 由来(2026-09-29 用户: "AI 对话好久没更新其调用工具和能力了"):
 *   `ChatPanel.tsx` 里那份 `TOOL_META` 是手抄的, 而且是**唯一**来源
 *   (`TOOL_META[name] ?? {label: name}`)—— 没登记的工具直接把英文原名显示给用户。
 *   实测差距: 后端 **75 个工具, 它只登记了 38 个**, 剩下 37 个(pdf_parse / orch_run /
 *   meta_invoke / format_eval / browser_control / view_openalex_search / 教育六件套 …)
 *   在对话的工具链里全显示成英文。
 *
 * 这不是"忘了补", 是**结构问题**: 只要前端手上有一份需要手工同步的清单, 它一定会烂,
 * 而且烂得**没有信号** —— 名字显示成英文不会报错, 界面看着还挺正常。
 *
 * 所以这里锁两条:
 *   ① 中文名以**后端**为准(前端必须去取 `/api/agent/tools`, 后端 75/75 都带 label);
 *   ② 那份手抄表只允许提供**后端给不了的东西**(`source` 数据源口径), 不许当唯一来源。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHAT_PANEL = path.join(here, "..", "web", "src", "components", "ChatPanel.tsx");

describe("对话页的工具名来源", () => {
  const raw = fs.readFileSync(CHAT_PANEL, "utf8");
  /**
   * ⚠ 断言前**先剥注释**。
   *   第一版直接用 `src.includes("/api/agent/tools")` —— 而我在说明里也写了这个路径,
   *   于是把 fetch 改成别的地址时**照样绿**。反向验证只翻了两条中的一条才发现。
   *   "判据看到了注释而不是代码"和"判据看到了别的东西"是同一类错。
   */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("**必须**从后端取实时工具表(而不是只靠手抄表)", () => {
    expect(
      src.includes("/api/agent/tools"),
      "ChatPanel 没有去取 /api/agent/tools —— 那就又回到了\"手抄一份、加工具时必然烂\"。" +
        "后端每个工具都带中文 label, 取一下就行。",
    ).toBe(true);
  });

  it("toolMeta 的 label **优先用实时表**, 手抄表只做兜底", () => {
    // 判据: label 的取值表达式里必须有来自实时表的那个来源
    const fn = src.slice(src.indexOf("function toolMeta("), src.indexOf("function toolMeta(") + 600);
    expect(
      /labels\[name\]\s*\|\|/.test(fn),
      "toolMeta 没有把实时表放在第一位 —— 后端加了新工具时, 这里还是会显示英文原名。",
    ).toBe(true);
    // 手抄表只能作为 `||` 后面的兜底, 不能是 `??` 前面那个唯一来源
    expect(/\?\?\s*\{[^}]*label:\s*name/.test(fn)).toBe(false);
  });

  it("手抄表不再声明 label 为必填(它已经退化成可选兜底)", () => {
    expect(
      /const TOOL_META: Record<string, \{ label\?: string; source: string \}>/.test(src),
      "TOOL_META 的类型又把 label 声明成必填了 —— 那会诱导后来者继续把它当唯一真源。",
    ).toBe(true);
  });
});
