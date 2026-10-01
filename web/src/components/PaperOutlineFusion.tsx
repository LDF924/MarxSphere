// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// PaperOutlineFusion.tsx — 研途写作舱视图的外层包装(2026-10-01)
//
// 由来: 新补的「PPT 生成工作台」自旧项目 AIToolman 的 M9 模块(111/606 个符号,
//   是它最大的模块)。本仓此前只有 `exportOutlinePptx`(封面 + 每章一页), 没有工作台。
//
// 为什么不单开一个导航 tab: 用户的原话是"这些新增的融入原有的 tab 中"。
//   PPT 工作台与研途写作舱同属"论文相关产出" —— 一个写正文, 一个做汇报,
//   分两处反而要在两个 tab 间来回找。
//
// ⚠ 默认仍是**写作舱原样**(Vue 子应用 iframe), 不是替换。
//   这层只多一个顶部切换: 不点它的话, 用户看到与改动前**完全一致**。
//   切换状态**不持久化** —— 每次都回到写作舱, 免得用户下次进来莫名其妙落在 PPT 上。
import { useState } from "react";
import FusionPanel from "./FusionPanel";   // default export
import { PPTWorkbenchPanel } from "./PPTWorkbenchPanel";
import { Presentation, PenLine } from "lucide-react";

/**
 * 写作舱这条 tab 定义 —— **从 App.tsx 的 FUSION_TABS.paperOutline 复制**。
 *
 * ⚠ 为什么复制而不是 import: `FUSION_TABS` 定义在 `App.tsx` 里, 而 App.tsx 要 import
 *   本组件 —— import 会成环。把整张表抽到 `lib/` 是更干净的做法, 但那要动 App.tsx 与
 *   另外 5 处引用, 超出本次改动范围。
 *   **两处必须保持一致**(title/vueRoute/hint 谁都不能单方面改), 改一处要同步另一处。
 */
const PAPER_OUTLINE_TAB = {
  title: "研途写作舱",
  vueRoute: "/workflow/input",
  hint: "阶段化论文研究: 选题界定 → 框架设计 → 文献与资料 → 章节写作 → 统稿定稿",
  hintList: true,
} as const;

export function PaperOutlineFusion({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<"write" | "ppt">("write");

  const tabBtn = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-medium transition-colors ${
      active ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 px-4 py-1.5"
        style={{ background: "hsl(222 47% 9%)", borderBottom: "1px solid hsl(217 33% 18%)" }}
      >
        <button type="button" data-control="paper-outline:view-write"
          onClick={() => setView("write")} className={tabBtn(view === "write")}>
          <PenLine className="h-3.5 w-3.5" /> 六步写作
        </button>
        <button type="button" data-control="paper-outline:view-ppt"
          onClick={() => setView("ppt")} className={tabBtn(view === "ppt")}>
          <Presentation className="h-3.5 w-3.5" /> PPT 演示
        </button>
        <span className="ml-2 text-[10px] text-slate-500">
          {view === "ppt" ? "由正文生成演示文稿：大纲 → 脚本 → 配图 → 导出" : "选题 → 框架 → 资料 → 写作 → 统稿 → 投稿"}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {view === "ppt" ? (
          <div className="h-full overflow-y-auto p-4">
            <PPTWorkbenchPanel />
          </div>
        ) : (
          // 默认路径: 与改动前**逐字节相同**的调用
          <FusionPanel panelKey="workflow-input"
            tab={{ ...PAPER_OUTLINE_TAB, onBack }} />
        )}
      </div>
    </div>
  );
}
