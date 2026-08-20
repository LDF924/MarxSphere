// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
// education-multimodal.ts — 教育多模态打通（复赛冲刺期实现）
// 在通用能力（image_analyze OCR / audio_transcribe whisper）之上提供教育高频功能：
//   ① 作业图片识别：拍照 → OCR 提取题目 → 直传 solve 辅导（无需手动贴文本）
//   ② 口语测评：录音 → 转写 → LLM 按 发音/流畅度/内容 三维评分 + 改进建议
//   ③ 板书识别：板书照 → OCR 结构化要点 + 错漏检测
// 合规: 语音仅本地处理 + 会话后即删（不落库不训练）；采集前明示学生
// 复用: analyzeImageAtPath（agent-tool-router）/ whisper（code-sandbox）
import { pool } from "../db/pool.js";
import { llmJson } from "./education-service.js";
import { solveQuestion } from "./homework-help-service.js";

// ═══ ① 作业图片识别：拍照 → OCR → 直传 solve ═══
export async function homeworkPhotoSolve(input: {
  subject: string;
  imagePath: string;            // agent_workspace 内相对路径
  studentId?: string;
  hintLevel?: "hint" | "guided" | "full";
  difficulty?: string;
}): Promise<Record<string, unknown>> {
  const { analyzeImageAtPath } = await import("./agent-tool-router.js");
  // ① OCR 提取题目（mode: ocr）
  const ocr = await analyzeImageAtPath(input.imagePath, "ocr");
  if (ocr.startsWith("（")) {
    return { ok: false, error: ocr };   // 图片错误（越界/不存在/过大/非图片/无 key）
  }
  const questionText = ocr.replace(/^【图片理解·ocr】[^\n]*\n/, "").trim();
  if (!questionText || questionText.length < 5) {
    return { ok: false, error: "OCR 未能提取到有效题目文本，请确认图片清晰度" };
  }

  // ② 直传 solve 辅导（photo 模式）
  const solution = await solveQuestion({
    subject: input.subject,
    question: questionText,
    mode: "photo",
    hintLevel: input.hintLevel || "hint",
    studentId: input.studentId,
  });

  return {
    ok: true,
    ocrText: questionText.slice(0, 500),
    solution: (solution as any).solution,
    hintLevel: (solution as any).hintLevel,
    pipeline: "拍照 → OCR → 直传 solve（photo 模式）",
  };
}

// ═══ ② 口语测评：转写 + 三维评分 ═══
export async function speechAssessment(input: {
  audioPath: string;            // agent_workspace 内音频路径
  subject: string;              // 如 "english" | "中文"
  reference?: string;           // 参考文本（可选）
  keepAudio?: boolean;          // 默认 false：会话后即删（合规）
}): Promise<Record<string, unknown>> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const workspace = path.join(process.env.SAG_ROOT || path.resolve(process.cwd()), "data", "agent_workspace");
  const target = path.resolve(workspace, String(input.audioPath).replace(/^[/\\]+/, ""));
  if (!(target === workspace || target.startsWith(workspace + path.sep))) return { ok: false, error: `（路径越界: ${input.audioPath}）` };
  if (!fs.existsSync(target)) return { ok: false, error: "（音频文件不存在）" };
  const ext = path.extname(target).toLowerCase();

  // ① whisper 转写（与 audio_transcribe 同模式：复制进隔离目录 + python 直调）
  const PYTHON = process.env.COGNEE_PYTHON || process.env.PYTHON_EXE || "";
  if (!PYTHON) return { ok: false, error: "未配置 COGNEE_PYTHON/PYTHON_EXE，口语测评不可用（需 python + faster-whisper）" };

  const sandboxDir = path.join(os.tmpdir(), "sag-edu-audio");
  fs.mkdirSync(sandboxDir, { recursive: true });
  const copyTarget = path.join(sandboxDir, "audio" + ext);
  fs.copyFileSync(target, copyTarget);

  const code = [
    "import sys",
    "p = sys.argv[1]",
    "try:",
    "  from faster_whisper import WhisperModel",
    "  model = WhisperModel('base', device='cpu', compute_type='int8')",
    "  segs, _ = model.transcribe(p)",
    "  print(''.join(s.text for s in segs))",
    "except ImportError:",
    "  import whisper",
    "  m = whisper.load_model('base')",
    "  r = m.transcribe(p)",
    "  print(r['text'])",
  ].join("\n");

  let transcript = "";
  try {
    const r = await execFileAsync(PYTHON, ["-c", code, copyTarget], { timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    transcript = (r.stdout || "").trim();
  } catch (e: any) {
    fs.rmSync(copyTarget, { force: true });
    return { ok: false, error: `转写失败: ${String(e?.stderr || e?.message || e).slice(0, 150)}` };
  } finally {
    try { fs.rmSync(copyTarget, { force: true }); } catch { /* ignore */ }
  }

  if (!transcript) return { ok: false, error: "转写无输出（whisper 可能未安装，pip install faster-whisper）" };

  // ② LLM 三维评分（发音/流畅度/内容）
  const judge = await llmJson(`你是口语测评老师。评学生口语录音转写文本：
【科目】${input.subject}
【转写】${transcript.slice(0, 1500)}
${input.reference ? `【参考文本】${input.reference.slice(0, 800)}` : ""}

按三维评分（各 1-5 分）:
1. 发音（pronunciation）：语音清晰度、准确性（参考文本对照）
2. 流畅度（fluency）：停顿/重复/节奏
3. 内容（content）：完整度、逻辑性、用词

输出 JSON: {
  "pronunciation": {"score": 1-5, "comment": "具体评价"},
  "fluency": {"score": 1-5, "comment": "具体评价"},
  "content": {"score": 1-5, "comment": "具体评价"},
  "total": 3-15,
  "improvements": ["可执行的改进建议"],
  "strengths": ["做得好的点"]
}`);

  // ③ 合规：默认会话后即删（不落库）
  let deleted = false;
  if (!input.keepAudio) {
    try { fs.unlinkSync(target); deleted = true; } catch { /* 删除失败不影响返回 */ }
  }

  return {
    ok: true,
    transcript: transcript.slice(0, 1000),
    assessment: judge,
    audioDeleted: deleted,
    note: "语音仅本地处理，会话后即删（不落库不训练）",
  };
}

// ═══ ③ 板书识别：OCR 结构化要点 + 错漏检测 ═══
export async function blackboardRecognize(input: {
  imagePath: string;
  subject?: string;              // 板书对应科目（可选）
  teacherSide?: boolean;         // 教师端调用（备课场景）
}): Promise<Record<string, unknown>> {
  const { analyzeImageAtPath } = await import("./agent-tool-router.js");
  const ocr = await analyzeImageAtPath(input.imagePath, "ocr");
  if (ocr.startsWith("（")) return { ok: false, error: ocr };
  const text = ocr.replace(/^【图片理解·ocr】[^\n]*\n/, "").trim();
  if (!text || text.length < 5) return { ok: false, error: "板书 OCR 未提取到有效内容" };

  // 结构化要点 + 错漏检测
  const judge = await llmJson(`你是教学辅助助手。整理板书内容：
【板书 OCR】${text.slice(0, 2000)}${input.subject ? `\n【科目】${input.subject}` : ""}

输出 JSON: {
  "title": "板书主题（推断）",
  "structure": [{"section":"要点/标题","content":"要点内容"}],
  "keyPoints": ["核心要点"],
  "errors": [{"issue":"疑似错漏（笔误/逻辑缺失）","reason":"判断依据"}],
  "suggestions": ["板书改进建议"]
}`);

  return {
    ok: true,
    blackboard: {
      title: judge?.title || "",
      structure: judge?.structure || [],
      keyPoints: judge?.keyPoints || [],
      errors: judge?.errors || [],
      suggestions: judge?.suggestions || [],
    },
    ocrExcerpt: text.slice(0, 300),
    role: input.teacherSide ? "teacher" : "student",
  };
}

export const educationMultimodalService = { homeworkPhotoSolve, speechAssessment, blackboardRecognize };
