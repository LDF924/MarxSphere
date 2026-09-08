// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// viz-agent-service.ts — SocialSci P0-4: 对话式科研绘图 Agent(独立轻量循环)
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
  const ep = getLlmEndpoint({ model: getRoleModel("reason") });
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
export async function runTurn(userId: string, sessionId: string, userMsg: string, sse: AttachedSse, opts: { csv?: string; columnOrder?: string[]; spec?: Record<string, unknown> } = {}): Promise<void> {
  const sess = await pool.query(`select * from viz_sessions where id=$1 and user_id=$2`, [sessionId, userId]);
  if (!sess.rows.length) { sse.error({ code: "NOT_FOUND", userMessage: "会话不存在", canRetry: false }); return; }
  await addMessage(sessionId, "user", { text: userMsg });

  sse.send("viz.started", {});
  let csv = opts.csv;
  let columnOrder = opts.columnOrder ?? [];

  try {
    // ─── 1. plan: 理解请求 → {分析意图, 数据操作描述, 需要数据吗} ───
    sse.send("thinking", { content: "正在理解绘图请求并规划数据操作..." });
    const plan = await llmJson(`你是科研绘图助手(Agent)。理解用户的绘图请求, 输出 JSON:
{"needsData":true/false,"dataOp":"数据操作描述(如: 按组画柱状图, x=维度, y=权重)","chartIntent":"要画的图一句话","pythonSketch":"实现思路(选库 matplotlib)","keepContext":true}

用户请求: ${userMsg}`);
    sse.send("plan", { content: plan?.chartIntent ?? userMsg, dataOp: plan?.dataOp ?? "" });

    // ─── 2. analyze_data: 真实计算(有数据时) ───
    let dataSummary = "";
    if (csv && columnOrder.length) {
      sse.send("model", { model: getRoleModel("reason") });
      sse.send("tool", { name: "analyze_data", status: "calling" });
      const ana = await vizExec.analyzeData(userId, csv, columnOrder);
      if (ana.ok) {
        dataSummary = ana.summary ?? "";
        sse.send("tool", { name: "analyze_data", status: "done", content: dataSummary.slice(0, 800), columns: ana.columns ?? [] });
      } else {
        sse.send("tool", { name: "analyze_data", status: "error", error: ana.error });
      }
    } else if (!csv) {
      sse.send("tool", { name: "analyze_data", status: "skipped", content: "无数据文件(示意图模式)" });
    }

    // ─── 3. chart 循环: 生成代码 → 渲染 → critique → fix(≤2轮) ───
    let code = "";
    let chartErr = "";
    let artifacts: { pngRel: string; svgRel: string } | null = null;
    let lastCritique = "";
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
      sse.send("tool", { name: "render_chart", status: "done", pngRel: rendered.pngRel, svgRel: rendered.svgRel });
      sse.send("chart", { artifact: { pngRel: rendered.pngRel, svgRel: rendered.svgRel }, version: round + 1, round, figureId });

      // ─── 4. critique 自审(强制步骤: 匹配度/统计正确/可视化规范) ───
      const crit = await llmJson(`你是科研图表审稿专家。审查刚生成的 matplotlib 图表方案, 输出 JSON:
{"issues":[{"severity":"error|warn|info","issue":"具体问题"}],"verdict":"pass|fix","improve":"如何修改"}

图表意图: ${plan?.chartIntent ?? userMsg}
绘图代码:
${code.slice(0, 4000)}
${dataSummary ? `数据概要: ${dataSummary.slice(0, 800)}` : "(示意图)"}

自审维度: ①与用户请求匹配? ②统计/数据表达正确?(真实计算 vs 编造) ③可视化规范(图表类型适配/坐标轴/标签/图例/中文)?`, 3000, 0.2);
      const issues: Array<{ severity: string; issue: string }> = Array.isArray(crit?.issues) ? crit.issues : [];
      const errors = issues.filter((i) => i.severity === "error");
      lastCritique = crit?.improve ?? issues.map((i) => `[${i.severity}] ${i.issue}`).join("\n");
      sse.send("critique", { round, verdict: crit?.verdict ?? "fix", issues: issues.slice(0, 5), improve: crit?.improve ?? "" });
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
      const ver = await pool.query(
        `insert into viz_artifacts
           (session_id, user_id, version, prompt, python_code, data_snapshot_ref, spec, png_path, svg_editable_path, critique, status)
         select $1, $2, coalesce(max(version),0)+1, $3, $4, $5, $6, $7, $8, $9, 'final'
           from viz_artifacts where session_id=$1
         returning version`,
        [sessionId, userId, userMsg, code, csv ? "session-csv" : "", JSON.stringify({ intent: plan?.chartIntent ?? "" }),
         artifacts.pngRel, artifacts.svgRel, JSON.stringify({ improve: lastCritique })]);
      const version = ver.rows[0]?.version ?? 1;
      await addMessage(sessionId, "chart", { artifact: artifacts, version, title: plan?.chartIntent ?? userMsg });
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

/** 期刊规范 → 绘图提示词片段(对齐闭源 VizView journal spec; 尺寸 mm/字号/线宽 描述) */
function specPrompt(spec: Record<string, unknown>): string {
  const w = spec.widthMm ? `图宽 ${spec.widthMm}mm` : "";
  const h = spec.heightMm ? `× 高 ${spec.heightMm}mm` : "";
  const dpi = spec.dpi ? `, 输出 ${spec.dpi} DPI` : "";
  const fs = spec.fontSize ? `, 字体 ${spec.fontSize}pt` : "";
  const ff = spec.fontFamily ? `(${spec.fontFamily})` : "";
  const lw = spec.lineWidth ? `, 轴线/数据线宽 ${spec.lineWidth}` : "";
  return `尺寸按 ${w}${h}${dpi}; 文字${fs}${ff}${lw}; 图内字号/线条请按此比例控制, 标题用中文简洁表述。`;
}
