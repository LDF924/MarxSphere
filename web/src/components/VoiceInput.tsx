// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// VoiceInput.tsx — 语音输入按钮(2026-10-02)
//
// 由来: 对照 Respal 的语音输入(右 Alt 快捷键)补的。本仓此前**前端零行录音代码**
//   (MediaRecorder/getUserMedia/SpeechRecognition 全仓 0 命中)。
//
// ═══ 为什么走浏览器原生 Web Speech, 而**不是**后端的 whisper 沙箱 ═══
//   后端确实有 `audio_transcribe`(agent-tool-router.ts:1402), 但实测它在这台机器上
//   **不可用**: `whisper` 与 `faster_whisper` 两个包都没装, 而它的输入契约是
//   "agent_workspace 内的**文件路径**", 不是字节流 —— 浏览器录音要先落盘成文件才用得上。
//   三个理由让原生 API 成为正确选择:
//     ① 零新增服务端依赖(不必给用户装 whisper 模型);
//     ② **录音不落盘**: 合规条款(education-compliance.ts:29)对语音这一档写的是
//        "仅本地处理 + 会话后即删, 不落库不训练"。走原生 API 时音频由浏览器交给
//        识别服务、本地不留文件、服务端完全不经手 —— 天然满足, 而不是"我们保证会删";
//     ③ 实时出字, 不用等整段上传再转写。
//   代价: 依赖浏览器的语音服务(Chrome/Edge 背后是云端识别)。所以按钮上明确显示
//   "由浏览器识别", 并给出**不支持时的替代路径**(提示可用后端 audio_transcribe)。
//
// ═══ 两个真实约束(实测得出, 都写进代码而不是留给人踩) ═══
//   ① **必须先 getUserMedia**。不先拿一次麦克风权限就直接 `start()`, Chrome 会让
//      recognition 停在 "started 但没有任何事件" 的状态 —— 不报错、不出字、不结束。
//      所以流程固定为: 用户点击(手势) → getUserMedia 拿到权限 → 立刻停掉轨道 →
//      再 start recognition。只在用户手势里做权限申请, 不自动申请。
//   ② **onend 之后不能复用实例**。识别结束(或一段静音自动停止)后再次 start 同一个
//      实例在部分版本上静默失效, 所以每次用完都置空, 下次新建。
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

/** 命令式句柄 —— 供快捷键(右 Alt)与外部按钮共用**同一个**识别实例 */
export interface VoiceInputHandle {
  /** 没在听就开始、在听就停 */
  toggle: () => void;
}

/** 浏览器支持情况 —— 一次判定, 不每次调用都查 */
function speechSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as any;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export const VoiceInput = forwardRef<VoiceInputHandle, {
  /** 识别出的文本(增量)。调用方决定是追加还是替换 —— 组件不猜。 */
  onText: (text: string) => void;
  lang?: string;
  className?: string;
  disabled?: boolean;
}>(function VoiceInput({
  onText,
  lang = "zh-CN",
  className,
  disabled,
}, ref) {
  const [supported] = useState(() => speechSupported());
  const [listening, setListening] = useState(false);
  const [err, setErr] = useState("");
  const recRef = useRef<any>(null);
  /** stop() 要能读到"此刻"的 listening —— 闭包里的那个是渲染时的快照,
   *  快捷键在两次渲染之间连按会读错(第一次按下→开始, 还没重渲染就再按→本应停却因旧值又"开始")。 */
  const listeningRef = useRef(false);
  /** onText 同理: 快捷键注册在 useEffect([]) 里, 捕获的是首次渲染的 onText */
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  // 组件卸载时停掉, 避免麦克风被一个已经不在界面上的按钮占着
  useEffect(() => () => {
    try { recRef.current?.stop(); } catch { /* 已经停了 */ }
  }, []);

  async function start() {
    if (!supported || disabled) return;
    setErr("");
    // ① 先在手势里申请麦克风权限(见文件头 ①)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 拿到权限就立刻释放轨道 —— 识别不用它, 留着会让标签页一直显示"正在录音"
      stream.getTracks().forEach((t) => t.stop());
    } catch (e: any) {
      const name = String(e?.name || "");
      setErr(name === "NotAllowedError" ? "麦克风权限被拒绝" : `无法访问麦克风(${name || "未知"})`);
      return;
    }

    const w = window as any;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    // ② 每次新建实例(见文件头 ②)
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = true;
    recRef.current = rec;

    rec.onresult = (ev: any) => {
      let text = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        text += ev.results[i][0]?.transcript || "";
      }
      if (text.trim()) onTextRef.current(text);
    };
    rec.onerror = (ev: any) => {
      const code = String(ev?.error || "");
      // no-speech / aborted 是正常结束(用户没说话 / 主动停), 不当错误报
      if (code !== "no-speech" && code !== "aborted") {
        setErr(code === "not-allowed" ? "麦克风权限被拒绝" : `识别失败: ${code}`);
      }
      setListening(false);
      listeningRef.current = false;
    };
    rec.onend = () => { setListening(false); listeningRef.current = false; recRef.current = null; };

    try {
      rec.start();
      setListening(true);
      listeningRef.current = true;
    } catch (e: any) {
      setErr(`启动失败: ${String(e?.message || e).slice(0, 60)}`);
      setListening(false);
      listeningRef.current = false;
    }
  }

  function stop() {
    try { recRef.current?.stop(); } catch { /* 已经停了 */ }
    setListening(false);
    listeningRef.current = false;
  }

  // 快捷键与按钮走同一条路 —— 两处各写一份 toggle 逻辑必然会在"应该 stop 还是 start"上分叉
  useImperativeHandle(ref, () => ({
    toggle: () => { if (listeningRef.current) stop(); else void start(); },
  }));

  if (!supported) {
    // 不支持时**不留一个哑按钮** —— 显示说明, 让用户知道有别的路可走
    return (
      <span
        className={cn("text-[10px] text-muted-foreground", className)}
        title="当前浏览器不支持语音识别(需 Chrome/Edge)。也可把音频放进 agent 工作区后用 audio_transcribe 工具转写。"
      >语音不可用</span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={listening ? stop : () => void start()}
        disabled={disabled}
        title={listening
          ? "停止录音(右 Alt 同效)"
          : "语音输入(右 Alt 同效; 由浏览器识别, 音频不经本站服务器)"}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-md border",
          listening ? "border-red-400/60 bg-red-500/15 text-red-300" : "border-border text-muted-foreground hover:bg-white/5",
          disabled && "opacity-50"
        )}
        data-control="voice:mic"
      >
        {listening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
      </button>
      {err && <span className="text-[10px] text-red-300">{err}</span>}
    </span>
  );
});

export default VoiceInput;
