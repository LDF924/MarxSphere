// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// TeacherWorkspacePanel.tsx — 教师端「教师工作台」（复赛冲刺期）
// 新增能力散布：备课 / 命题 / 批改 / 班级学情 / 板书识别 / 思政内容审核 / 先修图路径 / BKT 诊断（教学视角）
// 全部走 /api/education/* 新路由（teach / multimodal / audit / kg / cognitive）
import { useState } from "react";
import { Loader2, ShieldCheck, Camera, Network, Play } from "lucide-react";
import { EduResultCard } from "./EduResultView";
import { EduFeedbackFAB } from "./EduFeedbackFAB";

const API = "/api/education";

/** 与 EducationPanel 一致的调用方式（fetch 相对路径；path 为完整路径含 /api/education） */
async function post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

interface ResultBox {
  title: string;
  data?: unknown;
  error?: string;
}

export function TeacherWorkspacePanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [subject, setSubject] = useState("政治经济学");
  const [input, setInput] = useState("价值规律");
  const [auditInput, setAuditInput] = useState("");
  const [kgInput, setKgInput] = useState("");
  const [mediaInput, setMediaInput] = useState("");
  const [result, setResult] = useState<ResultBox | null>(null);

  const call = async (key: string, url: string, body: Record<string, unknown>, title: string) => {
    setBusy(key);
    setResult({ title, data: null });
    try {
      const r = await post(url, body);
      setResult({ title, data: r });
    } catch (e: any) {
      setResult({ title, error: String(e?.message || e).slice(0, 200) });
    } finally {
      setBusy(null);
    }
  };

  /** Demo 演示：填充输入框并触发对应调用 */
  const demoRun = (key: string, url: string, body: Record<string, unknown>, title: string, fills?: Record<string, string>) => {
    const setters: Record<string, (v: string) => void> = {
      input: setInput, auditInput: setAuditInput, kgInput: setKgInput, mediaInput: setMediaInput,
    };
    Object.entries(fills || {}).forEach(([k, v]) => setters[k]?.(v));
    void call(key, url, body, `${title}（Demo）`);
  };

  /** Demo 按钮 */
  const DemoBtn = ({ onClick, label = "Demo 演示" }: { onClick: () => void; label?: string }) => (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-lg border border-dashed border-emerald-300 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium text-emerald-600 hover:bg-emerald-500/20 transition-colors"
      title="一键填入示例并运行"
    >
      <Play className="h-3 w-3" /> {label}
    </button>
  );

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <EduFeedbackFAB role="teacher" scene="general" source="教师工作台" />
      {/* 教研闭环：备课 / 命题 / 批改 / 班级学情 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center justify-between text-sm font-semibold">备课辅助（大纲 / 教案 / 课件 / 分层）<DemoBtn onClick={() => demoRun("lesson", `${API}/teach/lesson`, { subject, chapter: "价值规律", classMinutes: 45 }, "备课教案", { input: "价值规律" })} /></div>
        <div className="mb-2 flex gap-1">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="科目" />
          <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-[2] rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="课程/章节/知识点" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("syllabus", `${API}/teach/syllabus`, { subject, courseName: input, weeks: 16 }, "课程大纲生成")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            课程大纲
          </button>
          <button disabled={busy !== null} onClick={() => call("lesson", `${API}/teach/lesson`, { subject, chapter: input, classMinutes: 45 }, "备课教案")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            备课教案
          </button>
          <button disabled={busy !== null} onClick={() => call("courseware", `${API}/teach/courseware`, { subject, courseName: input, knowledgePoint: input, slides: 10 }, "课件生成（含配图建议）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            课件生成
          </button>
          <button disabled={busy !== null} onClick={() => call("layered", `${API}/teach/layered`, { subject, chapter: input }, "分层教学设计（基础/进阶/挑战）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            分层设计
          </button>
        </div>
      </div>

      {/* 作业与考试 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center justify-between text-sm font-semibold">作业与考试（出题 / 批改 / 错题报告 / 组卷）<DemoBtn label="出题 Demo" onClick={() => demoRun("q-基础", `${API}/teach/questions`, { subject, knowledgePoint: "价值规律", tier: "基础", count: 3 }, "智能出题（基础题）", { input: "价值规律" })} /></div>
        <div className="mb-2 flex gap-1">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="科目" />
          <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-[2] rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="知识点/章节" />
        </div>
        <div className="flex flex-wrap gap-1">
          {["基础", "提升", "拓展"].map((tier) => (
            <button key={tier} disabled={busy !== null} onClick={() => call(`q-${tier}`, `${API}/teach/questions`, { subject, knowledgePoint: input, tier, count: 5 }, `智能出题（${tier}题）`)} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
              {tier}题
            </button>
          ))}
          <button disabled={busy !== null} onClick={() => call("exam", `${API}/teach/exam`, { subject, topic: input, questionCount: 8, includeAnswers: true }, "命题组卷（按知识点分布）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            组卷
          </button>
          <button disabled={busy !== null} onClick={() => call("wrong-report", `${API}/teach/wrong-report`, { subject, days: 30 }, "错题分析报告（班级/个人）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            错题报告
          </button>
          <button disabled={busy !== null} onClick={() => call("class-summary", `${API}/teach/class-summary`, { subject }, "班级学情汇总（共性盲区）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            班级学情
          </button>
          <button disabled={busy !== null} onClick={() => call("grade", `${API}/teach/grade`, { subject, questions: [{ question: "x²=9，x=?", studentAnswer: "3", correctAnswer: "±3", type: "objective", fullScore: 5 }] }, "作业批改（客观题自动判分）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            作业批改
          </button>
        </div>
        <div className="mt-1.5 text-[10px] text-muted-foreground">自动批改（客观题规则 + 主观题 LLM 评阅）</div>
      </div>

      {/* 课堂互动 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center justify-between text-sm font-semibold">课堂互动（讨论题 / 随堂测验 / 课堂总结）<DemoBtn label="讨论 Demo" onClick={() => demoRun("discussion", `${API}/teach/discussion`, { subject, topic: "价值规律", count: 3 }, "课堂讨论题生成", { input: "价值规律" })} /></div>
        <div className="mb-2 flex gap-1">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="科目" />
          <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-[2] rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="课程内容/知识点" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("discussion", `${API}/teach/discussion`, { subject, topic: input, count: 3 }, "课堂讨论题生成（含引导问题）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            讨论题
          </button>
          <button disabled={busy !== null} onClick={() => call("quiz", `${API}/teach/quiz`, { subject, topic: input, count: 5, autoAnswers: true }, "随堂测验生成（含答案）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            随堂测验
          </button>
          <button disabled={busy !== null} onClick={() => call("lecture-summary", `${API}/teach/lecture-summary`, { subject, topic: input, minutes: 45 }, "课堂总结（要点/作业/衔接）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            课堂总结
          </button>
        </div>
      </div>

      {/* 思政内容审核 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> 思政内容四维核验
          <span className="ml-auto"><DemoBtn onClick={() => demoRun("audit", `${API}/audit/content`, { content: "价值规律是商品经济的基本规律，商品交换以价值量为基础实行等价交换。", level: "medium", context: "课程辅导" }, "四维核验", { auditInput: "价值规律是商品经济的基本规律" })} /></span>
        </div>
        <div className="mb-2 flex gap-1">
          <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="待审核内容（如辅导输出）" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("audit", `${API}/audit/content`, { content: auditInput, level: "medium", context: "课程辅导" }, "四维核验（意识形态/准确性/引用/边界）")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[13px] text-white disabled:opacity-50">
            {busy === "audit" ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} 四维核验
          </button>
          <button disabled={busy !== null} onClick={() => call("calibrate", `${API}/audit/calibrate`, { concept: auditInput }, "权威校准（对照 Compiled Truth）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            权威校准
          </button>
        </div>
      </div>

      {/* 先修图 + 路径规划 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <Network className="h-3.5 w-3.5 text-emerald-600" /> 知识点先修图 · 路径规划
          <span className="ml-auto"><DemoBtn label="路径 Demo" onClick={() => demoRun("path", `${API}/kg/plan-path`, { subject, target: "剩余价值" }, "拓扑路径规划", { kgInput: "剩余价值" })} /></span>
        </div>
        <div className="mb-2 flex gap-1">
          <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="目标知识点（如：剩余价值）" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("prereq", `${API}/kg/check-prereq`, { subject, knowledgePoint: kgInput }, "先修缺失检测")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            先修检测
          </button>
          <button disabled={busy !== null} onClick={() => call("path", `${API}/kg/plan-path`, { subject, target: input }, "拓扑路径规划（先修-目标）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            路径规划
          </button>
          <button disabled={busy !== null} onClick={() => call("validate", `${API}/kg/validate-path`, { subject, path: [kgInput] }, "路径校验（先修逆序检测）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            路径校验
          </button>
          <button disabled={busy !== null} onClick={() => call("bkt", `${API}/cognitive/bkt-diagnose`, { subject }, "BKT 认知诊断（薄弱点）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            BKT 诊断
          </button>
        </div>
      </div>

      {/* 板书识别 + 口语测评 */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <Camera className="h-3.5 w-3.5 text-emerald-600" /> 多模态（板书识别 / 口语测评）
          <span className="ml-auto"><DemoBtn label="合规 Demo" onClick={() => demoRun("status", `${API}/compliance/status`, { studentId: "default" }, "合规状态")} /></span>
        </div>
        <div className="mb-2 flex gap-1">
          <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-[13px]" placeholder="图片/音频相对路径（agent_workspace 内）" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("blackboard", `${API}/multimodal/blackboard`, { imagePath: mediaInput, subject, teacherSide: true }, "板书识别（OCR → 结构化要点 + 错漏检测）")} className="rounded-lg bg-sky-600 px-3 py-1.5 text-[13px] text-white disabled:opacity-50">
            <Camera className="inline h-3 w-3" /> 板书识别
          </button>
          <button disabled={busy !== null} onClick={() => call("speech", `${API}/multimodal/speech-assessment`, { audioPath: mediaInput, subject: "english" }, "口语测评（转写 + 三维评分，语音即删）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            口语测评
          </button>
        </div>
      </div>

      {/* 教育数据合规（数据分级 / 状态 / 一键清理） */}
      <div className="rounded-xl border bg-card p-3">
        <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> 教育数据合规（§4.2）
        </div>
        <div className="flex flex-wrap gap-1">
          <button disabled={busy !== null} onClick={() => call("classification", `${API}/compliance/classification`, {}, "数据分级表（学习行为/教学交互/语音三级）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            数据分级
          </button>
          <button disabled={busy !== null} onClick={() => call("status", `${API}/compliance/status`, { studentId: "default" }, "合规状态（匿名标识/数据量/保留期/语音政策）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            合规状态
          </button>
          <button
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm("确定一键清理该学生的全部学情数据（作答/错题/掌握度/计划/复盘）？此操作不可撤销。")) {
                call("cleanup", `${API}/compliance/cleanup-student`, { studentId: "default" }, "一键清理学情数据（各表删除数量）");
              }
            }}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
          >
            一键清理（学生数据）
          </button>
          <button disabled={busy !== null} onClick={() => call("cleanup-expired", `${API}/compliance/cleanup-expired`, {}, "保留期清理（超 30 天历史数据自动删）")} className="rounded-lg bg-muted px-3 py-1.5 text-[13px] hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors">
            保留期清理
          </button>
        </div>
      </div>

      {/* 结果区（结构化渲染，不再呈现原始 JSON） */}
      <div className="lg:col-span-2">
        {result ? <EduResultCard title={result.title} data={result.data} error={result.error} /> : (
          <div className="rounded-xl border border-dashed border-border/60 py-8 text-center text-xs text-muted-foreground">
            在上方选择能力并填入内容，结果将以结构化卡片展示
          </div>
        )}
      </div>
    </div>
  );
}
