// agent-persistent-runtime.ts — 借鉴 wisp-science: Python 持久运行时
// 子进程常驻, 变量跨调用保持（重计算: 载入数据/训练模型只需一次）
// 设计: 每会话一个持久 Python 进程, 通过 stdin/stdout JSON-RPC 通信
// 安全: 黑名单(同沙箱) + 凭证隔离 env + 超时回收 + 会话数上限
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface PersistentRuntime {
  sessionId: string;
  /** 执行一段代码（与上次调用共享全局变量） */
  exec(code: string, timeoutMs?: number): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>;
  /** 关闭会话（回收进程） */
  close(): void;
}

// ═══ 会话管理 ═══
const sessions = new Map<string, {
  proc: ReturnType<typeof spawn>;
  buffer: string;
  pending: Array<{ resolve: (v: any) => void; reject: (e: Error) => void }>;
  lastActive: number;
}>();

const MAX_SESSIONS = 5;                          // 同时最多 5 个持久会话
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;  // 闲置 15 分钟回收
const EXEC_TIMEOUT_MS = 60_000;                  // 单次执行超时

/** 会话级危险操作黑名单（与 code-sandbox 对齐; 持久进程有状态, 更需防护） */
const BLACKLIST = [
  /rm\s+-rf|del\s+\/s|format\s|shutdown|reboot/i,
  /os\.system|subprocess\.(run|Popen)|exec\(|eval\(/i,
  /\.env|password|secret|api[_-]?key/i,
  /socket|listen\(|bind\(/i,
];

/** Python 解释器（复用 code-sandbox 探测逻辑; 保持一致的 venv） */
function pythonExe(): string {
  return process.env.SAG_SANDBOX_PYTHON
    || process.env.VENV_PYTHON
    || "";
}

/** 引导脚本: 常驻读 stdin 执行代码, JSON 回传结果（隔离 stdout/stderr） */
const BOOTSTRAP = `
import sys, json, io, traceback, contextlib
def _run(code):
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            exec(compile(code, '<persistent>', 'exec'), globals())
        return {"ok": True, "out": buf.getvalue()}
    except Exception:
        return {"ok": False, "out": buf.getvalue(), "err": traceback.format_exc(limit=3)}
for line in sys.stdin:
    try:
        req = json.loads(line)
        res = _run(req.get("code", ""))
        sys.stdout.write(json.dumps(res) + "\\n")
        sys.stdout.flush()
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "err": str(e)}) + "\\n")
        sys.stdout.flush()
`;

/** 创建持久 Python 会话（变量跨调用保持） */
export function createPersistentRuntime(label = "default"): PersistentRuntime | null {
  // 会话数上限: 超限回收最久未用
  if (sessions.size >= MAX_SESSIONS) {
    let oldestId: string | null = null;
    let oldestTs = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastActive < oldestTs) { oldestTs = s.lastActive; oldestId = id; }
    }
    if (oldestId) closeSession(oldestId);
  }
  const sessionId = randomUUID().slice(0, 8);
  try {
    const proc = spawn(pythonExe(), ["-u", "-c", BOOTSTRAP], {
      windowsHide: true,
      // 凭证隔离（同沙箱）
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !/(?:API_KEY|DASHSCOPE|DEEPSEEK|EMBEDDING|TOKEN|SECRET|PASSWORD)/i.test(k))
        ),
        PYTHONIOENCODING: "utf-8",
        SAG_PERSISTENT_RUNTIME: "1",
      },
    });
    const rec = { proc, buffer: "", pending: [] as Array<{ resolve: (v: any) => void; reject: (e: Error) => void }>, lastActive: Date.now() };
    sessions.set(sessionId, rec);
    proc.stdout?.on("data", (chunk: Buffer) => {
      rec.buffer += chunk.toString("utf8");
      // 按行解析 JSON 响应
      const lines = rec.buffer.split("\n");
      rec.buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const pending = rec.pending.shift();
        if (!pending) continue;
        try { pending.resolve(JSON.parse(line)); } catch { pending.reject(new Error("响应解析失败")); }
      }
    });
    proc.stderr?.on("data", () => { /* stderr 由 exec 的 stdout 捕获（redirect_stdout/stderr 已合并） */ });
    proc.on("exit", () => { sessions.delete(sessionId); rec.pending.forEach((p) => p.reject(new Error("进程已退出"))); });
    console.log(`[agent] wisp借鉴1 持久运行时创建: ${label} (session ${sessionId})`);
    return {
      sessionId,
      exec: (code, timeoutMs) => execInSession(sessionId, code, timeoutMs),
      close: () => closeSession(sessionId),
    };
  } catch (e: any) {
    console.error("[agent] 持久运行时创建失败:", String(e?.message || e).slice(0, 100));
    return null;
  }
}

/** 执行代码（共享上次的全局变量） */
function execInSession(sessionId: string, code: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const rec = sessions.get(sessionId);
  if (!rec || rec.proc.killed) {
    return Promise.resolve({ ok: false, stdout: "", stderr: "", error: "会话已关闭, 请重新创建" });
  }
  // 危险操作拦截
  for (const re of BLACKLIST) {
    if (re.test(code)) {
      return Promise.resolve({ ok: false, stdout: "", stderr: "", error: "代码含被禁止的危险操作（持久运行时安全策略拦截）" });
    }
  }
  rec.lastActive = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = rec.pending.indexOf(pending);
      if (idx >= 0) rec.pending.splice(idx, 1);
      reject(new Error(`执行超时(>${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    const pending = {
      resolve: (v: any) => {
        clearTimeout(timer);
        resolve({
          ok: v?.ok !== false,
          stdout: String(v?.out || ""),
          stderr: v?.err ? String(v.err) : "",
          error: v?.err ? String(v.err).slice(0, 200) : undefined,
        });
      },
      reject: (e: Error) => { clearTimeout(timer); reject(e); },
    };
    rec.pending.push(pending);
    try {
      rec.proc.stdin?.write(JSON.stringify({ code }) + "\n");
    } catch (e: any) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

/** 关闭会话 */
export function closeSession(sessionId: string): void {
  const rec = sessions.get(sessionId);
  if (!rec) return;
  try { rec.proc.kill(); } catch { /* 已退出 */ }
  sessions.delete(sessionId);
  console.log(`[agent] 持久运行时会话关闭: ${sessionId}`);
}

/** 闲置回收（预热钩子周期调用; 防僵尸进程） */
export function reapIdleSessions(now = Date.now()): number {
  let closed = 0;
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_IDLE_TIMEOUT_MS) {
      closeSession(id);
      closed++;
    }
  }
  if (closed > 0) console.log(`[agent] 持久运行时闲置回收: ${closed} 会话`);
  return closed;
}

/** 会话状态（诊断/前端） */
export function persistentRuntimeStatus(): Array<{ sessionId: string; idleMs: number; alive: boolean }> {
  const now = Date.now();
  return [...sessions.entries()].map(([id, s]) => ({ sessionId: id, idleMs: now - s.lastActive, alive: !s.proc.killed }));
}

export const agentPersistentRuntime = { createPersistentRuntime, closeSession, reapIdleSessions, persistentRuntimeStatus };
