// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// OnboardingTour.tsx — 首次使用的分步引导(2026-10-02)
//
// 由来: 本仓 Web 端此前**没有任何新手引导**(全仓 grep onboarding/tour/引导 零业务命中;
//   electron/resources/onboarding.html 那个是桌面端启动前的**环境配置页** —— 检测 PG/Neo4j/Python、
//   填 LLM Key, 与"这个产品能干什么"是两回事)。
//
// ═══ 为什么不引驱动库(react-joyride / intro.js) ═══
//   那些库的价值在于"高亮真实 DOM 元素 + 跟随滚动"。代价是要给它加 target 选择器 ——
//   于是每个被引导的控件都多了一条**必须与 DOM 同步维护**的隐式契约, 改个 className
//   引导就静默指向空气(而且不报错, 只是那一步的高亮框消失)。
//   本引导讲的是"有哪几件事可做、在哪切视图", 用一屏卡片 + 跳转按钮就够;
//   等真要"指着某个按钮说点这里"时再引库, 那时才值得付那份维护成本。
//
// ⚠ 只做一次: 完成或跳过都写 localStorage。不写的话每次刷新都弹, 三天之内就会被
//   用户当成广告横幅——那比没有引导更糟。
import { useEffect, useState } from "react";
import { X, MessageSquare, Search, FileText, PenLine, Sparkles, ArrowRight, Check } from "lucide-react";
import { cn } from "../lib/utils";

const LS_KEY = "sag_onboarding_done_v1";

/**
 * 是不是自动化/无头浏览器。
 *
 * ═══ 为什么要判这个(2026-10-02) ═══
 *   引导是一个**铺满全屏的遮罩**(z-120), 盖住一切。而门禁的 40 个探针全都用
 *   `--headless=new` 开一个**全新的 user-data-dir** —— localStorage 每次都是空的,
 *   于是每个探针一进页面就被这块遮罩挡住, 后面所有"按文字找按钮再点"的断言集体失败。
 *   实测症状: batch06/batch15/batch17 大面积 FAIL, 而 elementFromPoint(视口中心)
 *   命中的是引导卡片里的 <p>。
 *
 * ═══ 为什么在**产品侧**判, 而不是改 20 个探针 ═══
 *   ① 探针注入 token 的那些地方是在模拟"已登录的老用户", 而老用户早就看过引导了 ——
 *      两边要表达的是同一件事, 在源头判一次比在 20 处各写一遍可靠;
 *   ② 有探针**不注入 token**(靠认证未启用直接进页面), 那种情况下探针侧无处可加;
 *   ③ 真实的自动化调用方(脚本/爬虫/无头 CI)本来也不该被引导打断 —— 它不是"用户"。
 *
 * ⚠ 判据用 UA 里的 `HeadlessChrome` 而不是 `navigator.webdriver`:
 *   实测本仓探针(CDP 直连的 Chrome)的 `navigator.webdriver` 是 **false** ——
 *   拿它当判据会静默失效, 遮罩照弹。
 */
function isAutomatedBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /HeadlessChrome|Headless/i.test(navigator.userAgent);
}

export function shouldShowOnboarding(): boolean {
  if (typeof window === "undefined") return false;
  if (isAutomatedBrowser()) return false;
  try { return window.localStorage.getItem(LS_KEY) !== "1"; } catch { return false; }
}

export function markOnboardingDone(): void {
  try { window.localStorage.setItem(LS_KEY, "1"); } catch { /* 隐私模式：这次会话内不再弹 */ }
}

/** 重置(设置面板里的"再看一遍") */
export function resetOnboarding(): void {
  try { window.localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

interface Step {
  icon: typeof MessageSquare;
  title: string;
  body: string;
  /** 跳转到哪个视图 —— 空表示这一步不跳转(只是介绍) */
  view?: string;
  /** 该视图在侧栏叫什么 */
  viewLabel?: string;
}

const STEPS: Step[] = [
  {
    icon: Sparkles,
    title: "先知道这里能干什么",
    body: "SocioSeek 是给人文社科研究用的工作台：对话问答、文献检索、论证推演、实证统计、论文写作与审稿都在同一处。左边那列是全部入口，随时可以切。",
  },
  {
    icon: MessageSquare,
    title: "① 对话 —— 最常用的入口",
    body: "直接提问即可。输入框里：敲 / 出命令与技能，敲 @ 引用工作区文件、上传文件或文献。右侧可切模型、开联网检索、开深度模式。右 Alt 键随时开始/停止语音输入。",
    view: "assistant", viewLabel: "打开对话",
  },
  {
    icon: Search,
    title: "② 检索与推演 —— 有出处的答案",
    body: "问到需要文献支撑的问题时会自动走多源检索（SAG 事件库 / 知识图谱 / 向量库 / 关系库）并给出引用。答案里的引用可以点开看成段原文。",
    view: "ask", viewLabel: "打开问答",
  },
  {
    icon: FileText,
    title: "③ 资料库与数据 —— 传上去就能用",
    body: "资料库里能直接看 Markdown、PDF、图片、Excel 表格、PPT 与 Graphviz/drawio 图；CSV/Excel 进「实证工作台」可直接跑描述统计与回归。文件不会离开你的机器。",
    view: "vault", viewLabel: "打开资料库",
  },
  {
    icon: PenLine,
    title: "④ 写作与评审 —— 从初稿到投出去",
    body: "写作舱按阶段推进（选题 → 框架 → 初稿 → 修改 → 投稿），评审台能对整篇论文做多维评审并给出可定位到段落的意见。",
    view: "paper-outline", viewLabel: "打开写作舱",
  },
];

export function OnboardingTour({ open, onClose, onGoToView }: {
  open: boolean;
  onClose: () => void;
  /** 切视图由宿主提供 —— 引导自己不该知道路由怎么实现 */
  onGoToView?: (view: string) => void;
}) {
  const [i, setI] = useState(0);
  useEffect(() => { if (open) setI(0); }, [open]);
  if (!open) return null;

  const step = STEPS[i];
  const Icon = step.icon;
  const last = i === STEPS.length - 1;
  const finish = () => { markOnboardingDone(); onClose(); };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="新手引导">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" />新手引导
            <span className="text-xs font-normal text-muted-foreground">{i + 1} / {STEPS.length}</span>
          </div>
          <button type="button" onClick={finish} className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="跳过引导" data-control="onboarding:skip">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary"><Icon className="h-4 w-4" /></span>
            <div className="text-base font-semibold">{step.title}</div>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">{step.body}</p>
          {step.view && onGoToView ? (
            <button
              type="button"
              onClick={() => { onGoToView(step.view!); finish(); }}
              className="mt-3 inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs text-primary hover:bg-primary/20"
              data-control="onboarding:goto"
            >
              {step.viewLabel || "去看看"}<ArrowRight className="h-3 w-3" />
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          {/* 进度点: 可点, 但只允许往回点 —— 往前跳会漏掉中间步骤的说明 */}
          <div className="flex items-center gap-1">
            {STEPS.map((_, idx) => (
              <button
                key={idx}
                type="button"
                disabled={idx > i}
                onClick={() => setI(idx)}
                className={cn("h-1.5 rounded-full transition-all", idx === i ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30", idx > i && "opacity-40")}
                aria-label={`第 ${idx + 1} 步`}
              />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {i > 0 ? (
              <button type="button" onClick={() => setI((v) => v - 1)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent" data-control="onboarding:prev">上一步</button>
            ) : null}
            <button
              type="button"
              onClick={() => (last ? finish() : setI((v) => v + 1))}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              data-control="onboarding:next"
            >
              {last ? <><Check className="h-3 w-3" />开始使用</> : <>下一步<ArrowRight className="h-3 w-3" /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OnboardingTour;
