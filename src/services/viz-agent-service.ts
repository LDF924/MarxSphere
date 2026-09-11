// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// viz-agent-service.ts — SocialSci P0-4: 对话式科研绘图 Agent(独立轻量循环)
// 模型角色: viz(用户可单独切换, 见 /api/llm/models) — 规划/出图/自审三段共用
// 循环: turn = plan(LLM 结构化) → analyze_data(真实计算) → chart(出图代码)
//        → critique(自审: 匹配/统计/可视化规范) → critique_fix(≤2轮自动修订) → 版本落盘
// SSE 事件=会话角色流: viz.created/started/plan/model/thinking/tool/chart/critique/critique_fix/delta/done
// 迁移118 viz_sessions/viz_messages/viz_artifacts
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { getRoleModel } from "./llm-model-registry.js";
import { getLlmEndpoint, fetchLlm, parseLlmJson } from "../ai/llm-common.js";
import * as vizExec from "./viz-exec-service.js";
import type { AttachedSse } from "../api/stream-utils.js";

const MAX_CRITIQUE_ROUNDS = 2;

async function llmJson(prompt: string, maxTokens = 5000, temperature = 0.4): Promise<any | null> {
  const ep = getLlmEndpoint({ model: getRoleModel("viz") });
  const res = await fetchLlm({
    url: ep.url, key: ep.key, model: ep.model,
    messages: [{ role: "user", content: prompt + "\n\n只输出 JSON, 不要其他文字。" }],
    temperature, maxTokens, timeoutMs: 240_000,
  });
  if (!res?.text) return null;
  return parseLlmJson(res.text);
}

export async function createSession(userId: string, title: string): Promise<{ id: string }> {
  const id = randomUUID();
  await pool.query(`insert into viz_sessions (id, user_id, title) values ($1,$2,$3)`, [id, userId, title]);
  return { id };
}

export async function listSessions(userId: string) {
  const r = await pool.query(
    `select s.id, s.title, s.status, s.created_at, s.updated_at,
            (select count(*) from viz_artifacts a where a.session_id=s.id) as artifact_count
       from viz_sessions s where s.user_id=$1 order by s.updated_at desc limit 50`, [userId]);
  return r.rows;
}

export async function listMessages(userId: string, sessionId: string, limit = 100) {
  const r = await pool.query(
    `select m.* from viz_messages m
       join viz_sessions s on s.id=m.session_id
      where m.session_id=$1 and s.user_id=$2 order by m.seq asc limit $3`,
    [sessionId, userId, limit]);
  return r.rows;
}

export async function listArtifacts(userId: string, sessionId: string) {
  const r = await pool.query(
    `select a.* from viz_artifacts a
       join viz_sessions s on s.id=a.session_id
      where a.session_id=$1 and s.user_id=$2 order by a.version desc`, [sessionId, userId]);
  return r.rows;
}

async function addMessage(sessionId: string, role: string, content: unknown) {
  await pool.query(
    `insert into viz_messages (session_id, role, content, seq)
     select $1, $2, $3, coalesce(max(seq),0)+1 from viz_messages where session_id=$1`,
    [sessionId, role, JSON.stringify(content)]);
}

/** 一轮对话(用户消息 → Agent 循环 → SSE 事件流 → 最新产物) */
export async function runTurn(userId: string, sessionId: string, userMsg: string, sse: AttachedSse, opts: { csv?: string; columnOrder?: string[]; spec?: Record<string, unknown>; fileName?: string } = {}): Promise<void> {
  const sess = await pool.query(`select * from viz_sessions where id=$1 and user_id=$2`, [sessionId, userId]);
  if (!sess.rows.length) { sse.error({ code: "NOT_FOUND", userMessage: "会话不存在", canRetry: false }); return; }
  await addMessage(sessionId, "user", { text: userMsg });

  sse.send("viz.started", {});
  let csv = opts.csv;
  let columnOrder = opts.columnOrder ?? [];
  let dataFileName = opts.fileName ?? "";
  if (csv && csv.trim() && columnOrder.length) {
    rememberSessionData(sessionId, csv, columnOrder, dataFileName);
  } else {
    // 本条消息没带数据 → 复用本会话已确定的数据源(第二条请求不应退化回示意图)
    const cached = sessionData.get(sessionId);
    if (cached) { csv = cached.csv; columnOrder = cached.columnOrder; dataFileName = cached.fileName; }
  }
  const haveData = !!(csv && csv.trim() && columnOrder.length);

  try {
    // ─── 1. plan: 理解请求 → {分析意图, 数据操作描述, 需要数据吗} ───
    sse.send("thinking", { content: "正在理解绘图请求并规划数据操作..." });
    const plan = await llmJson(`你是科研绘图助手(Agent)。理解用户的绘图请求, 输出 JSON:
{"needsData":true/false,"dataOp":"数据操作描述(如: 按组画柱状图, x=维度, y=权重)","chartIntent":"要画的图一句话","pythonSketch":"实现思路(选库 matplotlib)","keepContext":true}

用户请求: ${userMsg}`);
    sse.send("plan", { content: plan?.chartIntent ?? userMsg, dataOp: plan?.dataOp ?? "" });

    // ─── 2. analyze_data: 真实计算(有数据时) ───
    let dataSummary = "";
    if (haveData) {
      sse.send("model", { model: getRoleModel("viz") });
      sse.send("tool", { name: "analyze_data", status: "calling" });
      const ana = await vizExec.analyzeData(userId, csv!, columnOrder);
      if (ana.ok) {
        dataSummary = ana.summary ?? "";
        sse.send("tool", { name: "analyze_data", status: "done", content: dataSummary.slice(0, 800), columns: ana.columns ?? [] });
      } else {
        sse.send("tool", { name: "analyze_data", status: "error", error: ana.error });
      }
    } else {
      // 无数据 = 示意图模式: 必须显式告知, 且提示词禁止伪装成真实分析结果
      // (2026-09-11 修: 此前 fileId 被后端丢弃, 任务静默变成 LLM 编数据的示意图, 用户看不出区别)
      sse.send("tool", { name: "analyze_data", status: "skipped", content: "未绑定数据 — 本图为示意/概念图, 数值非真实数据" });
    }

    // ─── 3. chart 循环: 生成代码 → 渲染 → critique → fix(≤2轮) ───
    let code = "";
    let chartType = "";
    let chartErr = "";
    let artifacts: { pngRel: string; svgRel: string } | null = null;
    let lastCritique = "";
    let lastCaption = "";
    let lastAnalysis = "";
    let done = false;
    // 本次 turn 的稳定图身份: chart 事件多次迭代(自审修订)共用同一 figureId,
    // 前端按 vizJobId+figureId 合并到同一图卡(闭源 Xe() 语义), 避免每版本开新卡
    const figureId = `figure:${randomUUID().slice(0, 8)}`;

    for (let round = 0; round <= MAX_CRITIQUE_ROUNDS && !done; round++) {
      const isFix = round > 0;
      sse.send("thinking", { content: isFix ? "根据自审意见修订图表代码..." : "生成绘图代码并渲染..." });
      const gen = await llmJson(`${isFix ? "你是科研绘图修复专家。上次自审发现以下问题, 修订绘图代码:\n" + lastCritique + "\n\n" : ""}你是科研绘图专家。基于请求与数据概要生成 matplotlib 绘图代码, 输出 JSON:
{"code":"完整 python 代码(只写绘图部分, 不含 plt.show/保存; 若数据在 DATA_CSV 用 pd.read_csv(DATA_CSV) 读取; 中文标题/标签需直接使用)", "title":"图表标题"}

请求: ${userMsg}
${dataSummary ? `数据概要:\n${dataSummary.slice(0, 1500)}` : "(无数据, 画概念/示意图, 用示例数据或纯结构示意)"}
${haveData ? "图标题与轴标签只允许使用数据中真实存在的列名/取值, 禁止臆造年份、单位、地域、样本量等数据里没有的信息(如数据无年份列则标题不写年份)。" : "⚠ 本次无绑定数据: 只能画概念/示意图。禁止编造看似真实的调查数值(不要写「2018年 12.3%」这类具体数据点); 坐标轴用示意刻度, 图上或标题注明「示意」。"}
${opts.spec ? `【期刊规范(必须遵循)】\n${specPrompt(opts.spec)}` : ""}
${round > 0 ? "注意: 必须修复上轮 critique 指出的全部问题!" : ""}`, 4000, isFix ? 0.2 : 0.4);
      code = String(gen?.code ?? "").trim();
      if (!code) { sse.error({ code: "NO_CODE", userMessage: "AI 未能生成绘图代码", canRetry: true }); break; }

      sse.send("tool", { name: "render_chart", status: "calling", round });
      const rendered = await vizExec.renderChart(userId, code, csv, columnOrder, opts.spec ?? {});
      if (!rendered.ok) {
        chartErr = rendered.error ?? "渲染失败";
        sse.send("tool", { name: "render_chart", status: "error", error: chartErr.slice(0, 400) });
        // 渲染失败也走一轮修复(把错误喂给 critique 等价逻辑)
        lastCritique = `渲染报错: ${chartErr}`;
        if (round === MAX_CRITIQUE_ROUNDS) { sse.error({ code: "CHART_FAILED", userMessage: `多次渲染失败: ${chartErr.slice(0, 120)}`, canRetry: true }); break; }
        continue;
      }
      artifacts = { pngRel: rendered.pngRel!, svgRel: rendered.svgRel! };
      chartType = classifyChart(userMsg, code);
      sse.send("tool", { name: "render_chart", status: "done", pngRel: rendered.pngRel, svgRel: rendered.svgRel, chartType });

      // ─── 4. critique 自审(强制步骤: 匹配度/统计正确/可视化规范) ───
      const crit = await llmJson(`你是科研图表审稿专家。审查刚生成的 matplotlib 图表方案, 输出 JSON:
{"issues":[{"severity":"error|warn|info","issue":"具体问题"}],"verdict":"pass|fix","improve":"如何修改","caption":"图注(一句话概括该图表达什么)","analysis":"简短分析(≤100字, 说明该图读出的要点)"}

图表意图: ${plan?.chartIntent ?? userMsg}
绘图代码:
${code.slice(0, 4000)}
${dataSummary ? `数据概要:\n${dataSummary.slice(0, 800)}` : "(无数据: 仅概念/示意)"}
${haveData ? "本图使用了真实数据。" : "⚠ 本图无绑定数据, 若代码编造了具体数值应判 verdict=fix。"}

硬性要求(违反即 verdict=fix):
① caption/analysis 只能陈述数据与图表本身已有的事实, **禁止添加数据中不存在的年份、单位、地域、结论**(例: 数据无年份则不得写"2023年")。
② 若本图用了真实数据, 不得称其为"示意/模拟"。

自审维度: ①与用户请求匹配? ②统计/数据表达正确?(真实计算 vs 编造) ③可视化规范(图表类型适配/坐标轴/标签/图例/中文)?`, 3000, 0.2);
      const issues: Array<{ severity: string; issue: string }> = Array.isArray(crit?.issues) ? crit.issues : [];
      const errors = issues.filter((i) => i.severity === "error");
      lastCritique = crit?.improve ?? issues.map((i) => `[${i.severity}] ${i.issue}`).join("\n");
      // 图注/分析源自自审结果(闭源 chart 事件带 caption/analysisText, 前端图卡与底部栏直接消费)
      lastCaption = String(crit?.caption ?? "").trim() || String(plan?.chartIntent ?? "");
      lastAnalysis = String(crit?.analysis ?? "").trim();
      sse.send("critique", { round, verdict: crit?.verdict ?? "fix", issues: issues.slice(0, 5), improve: crit?.improve ?? "" });
      // 出图事件放在自审后: 图注/分析来自同一轮 critique, 与之同版本(闭源 chart 事件同样带 caption/analysisText)
      // code 必须一并下发: 前端画布「代码」页签直接消费, 此前不带 → 实时出图后代码页签恒空
      //  (恢复历史任务时之所以有代码, 是因为走的是 getVizJob 的 python_code, 不是这条事件)
      sse.send("chart", {
        artifact: { pngRel: rendered.pngRel, svgRel: rendered.svgRel },
        version: round + 1, round, figureId,
        caption: lastCaption, analysisText: lastAnalysis, chartType,
        code,
        // 必须下发: 前端画布据此打「真实数据 / 示意」徽标。此前漏发 → p.sampleData 恒 false,
        //   未绑数据的示意图被标成「✓ 真实数据」(与后端 spec.sampleData 自相矛盾)
        sampleData: !haveData,
        dataFile: haveData ? dataFileName : "",
      });
      if (crit?.verdict === "pass" && errors.length === 0) {
        done = true;
        sse.send("critique_fix", { content: "图表通过自审" });
      } else if (round === MAX_CRITIQUE_ROUNDS) {
        sse.send("critique_fix", { content: "已达自审修订上限, 采纳当前版本" });
        done = true;
      } else {
        sse.send("critique_fix", { content: `第${round + 1}轮修订: ` + (crit?.improve ?? "修正问题"), issues: issues.slice(0, 5) });
      }
    }

    // ─── 5. 版本落盘 ───
    if (artifacts) {
      // spec 里带上图注/分析/数据来源, 产物列表(版本时间线)与恢复画布都能直接展示
      const artSpec = {
        ...(opts.spec ?? {}),
        caption: lastCaption,
        analysis: lastAnalysis,
        chartType: chartType || "图表",
        dataFile: haveData ? dataFileName : "",
        sampleData: !haveData,
      };
      const ver = await pool.query(
        `insert into viz_artifacts
           (session_id, user_id, version, prompt, python_code, data_snapshot_ref, spec, png_path, svg_editable_path, critique, status)
         select $1, $2, coalesce(max(version),0)+1, $3, $4, $5, $6, $7, $8, $9, 'final'
           from viz_artifacts where session_id=$1
         returning version`,
        [sessionId, userId, userMsg, code, csv ? "session-csv" : "", JSON.stringify(artSpec),
         artifacts.pngRel, artifacts.svgRel, JSON.stringify({ improve: lastCritique })]);
      const version = ver.rows[0]?.version ?? 1;
      await addMessage(sessionId, "chart", { artifact: artifacts, version, title: plan?.chartIntent ?? userMsg, caption: lastCaption });
      await addMessage(sessionId, "done", { version });
      await pool.query(`update viz_sessions set updated_at=now(), title=coalesce(nullif(title,''),$2) where id=$1`,
        [sessionId, String(plan?.chartIntent ?? userMsg).slice(0, 60)]);
      sse.send("viz.completed", { version, artifact: artifacts, chartIntent: plan?.chartIntent ?? "" });
    } else if (!code) {
      // 已发 NO_CODE 错误
    } else {
      await addMessage(sessionId, "done", { error: chartErr });
      sse.error({ code: "CHART_FAILED", userMessage: `图表生成失败: ${chartErr.slice(0, 150)}`, canRetry: true });
    }
    sse.send("done", {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await addMessage(sessionId, "done", { error: msg });
    sse.error({ code: "VIZ_TURN_FAILED", userMessage: msg, canRetry: true });
  }
}

/** 会话级数据来源: 数据文件一旦确定就该整场生效, 不必每条消息重传(前端也只在发消息时带) */
const sessionData = new Map<string, { csv: string; columnOrder: string[]; fileName: string }>();
const MAX_SESSION_CACHE = 50;

/** 记住本会话的数据来源(chartType 判定与后续轮次复用) */
function rememberSessionData(sessionId: string, csv: string, columnOrder: string[], fileName: string): void {
  if (sessionData.has(sessionId)) sessionData.delete(sessionId);
  sessionData.set(sessionId, { csv, columnOrder, fileName });
  while (sessionData.size > MAX_SESSION_CACHE) {
    const oldest = sessionData.keys().next().value;
    if (oldest === undefined) break;
    sessionData.delete(oldest);
  }
}

/**
 * 图表类型标签(版本时间线展示用) — 确定性映射, 不额外调 LLM。
 * 后端只产出 PNG, 浏览器无从判断图类型; 此前前端只能显示 chartType 为空 → 每张图都没有中文标签。
 * 注意: 流程图/示意图常用 plt.plot 画连线, 不能把 plot( 当作折线信号(实测把方法流程图误标成折线图)。
 */
export function classifyChart(prompt: string, code: string): string {
  const s = `${prompt} ${code}`;
  if (/(流程图|示意图|框架图|flowchart|技术路线)/i.test(s)) return "流程图";
  if (/(森林图|forest)/i.test(s)) return "森林图";
  if (/(散点|scatter|regplot|lmplot)/i.test(s)) return "散点图";
  if (/(箱线|boxplot)/i.test(s)) return "箱线图";
  if (/(小提琴|violin)/i.test(s)) return "小提琴图";
  if (/(热力|heatmap|imshow)/i.test(s)) return "热力图";
  if (/(直方|hist\(|kind\s*=\s*['\"]hist)/i.test(s)) return "直方图";
  if (/(饼图|pie\(|kind\s*=\s*['\"]pie)/i.test(s)) return "饼图";
  if (/(折线|lineplot)/i.test(s)) return "折线图";
  // kind='bar' / kind="barh" 也是柱/条形(pandas .plot 的常见写法), 漏了会被下面的 plot( 兜底判成折线
  if (/(柱状|柱形|条形|barplot|barh|bar\(|kind\s*=\s*['\"]bar)/i.test(s)) return "柱状图";
  // 具体图型都没命中时, 才用宽泛的 plot( 兜底; 放在最后避免把 bar/barh 判成折线
  if (/(折线|line|plot\()/i.test(s)) return "折线图";
  return "";
}

/** 期刊规范 → 绘图提示词片段(对齐闭源 VizView journal spec; 尺寸 mm/字号/线宽 描述) */
function specPrompt(spec: Record<string, unknown>): string {
  const w = spec.widthMm ? `图宽 ${spec.widthMm}mm` : "";
  const h = spec.heightMm ? `× 高 ${spec.heightMm}mm` : "";
  const dpi = spec.dpi ? `, 输出 ${spec.dpi} DPI` : "";
  const fs = spec.fontSize ? `, 字体 ${spec.fontSize}pt` : "";
  const ff = spec.fontFamily ? `(${spec.fontFamily})` : "";
  const lw = spec.lineWidth ? `, 轴线/数据线宽 ${spec.lineWidth}` : "";
  const parts = [`尺寸按 ${w}${h}${dpi}; 文字${fs}${ff}${lw}; 图内字号/线条请按此比例控制, 标题用中文简洁表述。`];
  // journalConfig 透传的期刊/版式/配色(此前只被前端发来、后端丢弃)
  if (spec.journal) parts.push(`目标期刊规范: ${spec.journal}。`);
  if (spec.layout === "single-column") parts.push("版式: 单栏, 图内元素不要过密。");
  else if (spec.layout === "double-column") parts.push("版式: 双栏通栏。");
  if (spec.colorScheme) parts.push(`配色方案: ${spec.colorScheme}(避免红绿同现, 保证灰度打印仍可区分)。`);
  return parts.join(" ");
}
