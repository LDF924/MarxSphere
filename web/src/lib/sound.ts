// SPDX-License-Identifier: AGPL-3.0-or-later WITH SocioSeek-Exception
// sound.ts — 界面提示音(2026-10-02)
//
// 由来: 对照 Respal 的"任务完成音效"补的。本仓此前**全仓零行音频代码**
//   ( `new Audio` / `AudioContext` / `.play()` 在 web/src、src、electron、scripts 全部 0 命中 ),
//   也没有任何音频素材文件(web/public 只有 png 与 pdfium)。
//
// ═══ 为什么用 WebAudio 合成, 而不是打包 mp3 ═══
//   ① 零素材文件: 三个音就是几个正弦波的包络, 不值当往仓库塞二进制;
//   ② 无网络/无解码: 不占带宽、不用等 decodeAudioData, 出声延迟就是 setValueAtTime 的精度;
//   ③ 音量可控且不刺耳: 可以精确控制起落包络(见下方 attack/release), 打包的 mp3
//      起点常带爆音, 短促提示音上很明显。
//
// ═══ 浏览器给的两条硬约束(踩过才写在这里, 不是理论) ═══
//   ① **AudioContext 必须由用户手势创建/唤醒**。自动播放策略下, 页面加载时直接
//      `new AudioContext()` 会拿到 state="suspended", 之后 `start(when)` 全部静默丢弃 ——
//      不报错、不出声, 表现为"音效功能是坏的"。所以: 全局懒建一个 context,
//      每次播放前若 state!=="running" 就 resume();
//   ② **不能让默认状态是"有声音"**。这是研究/写作工具, 多数人戴着耳机在图书馆用。
//      默认关, 用户主动在设置里打开(或命令面板里开), 才创建 context。
//
// 与"设置持久化"的关系: 开关存 localStorage(`sag_sound`), 与会话级偏好一样是**本地**
//   偏好 —— 音量/是否出声是这台设备的事, 换台机器应该重新选, 不适合跟账号走。
//   这也是为什么没走 /api/agent/settings(那个是跨设备同步的运行时常量)。

const LS_KEY = "sag_sound";

/** 音效种类 —— 每个对应一个可区分的音型(不靠音量区分, 靠音高与走向) */
export type SoundKind =
  /** 消息已发出: 短促上行两音 */
  | "send"
  /** 任务/回答完成: 上行三音, 松弛 */
  | "done"
  /** 出错/失败: 下行两音 */
  | "error"
  /** 需要人注意(通知/提醒): 单音轻点 */
  | "notify";

/** 是否开启 —— 默认 **关**(见文件头 ②) */
export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(LS_KEY) === "1"; } catch { return false; }
}

export function setSoundEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (on) window.localStorage.setItem(LS_KEY, "1");
    else { window.localStorage.removeItem(LS_KEY); ctx?.close().catch(() => {}); ctx = null; }
  } catch { /* 隐私模式下 localStorage 会抛, 忽略: 本次会话仍可用 */ }
}

/** 音频上下文 —— 全局一个。懒建(见文件头 ①), 关闭音效时销毁以释放音频设备 */
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try { ctx = new Ctor() as AudioContext; } catch { return null; }
  return ctx;
}

/**
 * 在**用户手势**里调用一次, 把音频上下文唤醒。
 * 设置面板里"试听"按钮点一下就调它 —— 既验证了音效可用, 又顺手解除了自动播放限制,
 * 之后真正的事件音(不是手势触发的)才出得来。
 */
export function primeAudio(): void {
  const c = context();
  if (c && c.state !== "running") void c.resume().catch(() => {});
}

/** 一个音: 频率 + 起始时刻(相对 now) + 时长, 带 attack/release 防爆音 */
function tone(c: AudioContext, freq: number, at: number, dur: number, gain: number): void {
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  // 5ms 起音 / 剩下时间衰减 —— 直接 setValueAtTime(0.2) 再瞬间归零会有明显"咔"声
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.005);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(amp);
  amp.connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.01);
}

/**
 * 播放提示音。未开启音效时**直接返回**, 不创建 context(见文件头 ②)。
 * 任何异常都吞掉: 提示音永远不该让一个业务动作失败。
 */
export function playSound(kind: SoundKind): void {
  if (!isSoundEnabled()) return;
  const c = context();
  if (!c) return;
  if (c.state !== "running") {
    // 还没被手势唤醒 —— resume 是异步的, 这一声会丢, 但下一次就正常了。
    // 比"每次事件都排队等 resume"更简单, 也避免声音迟到到语境已经变了。
    void c.resume().catch(() => {});
    return;
  }
  const t = c.currentTime;
  try {
    switch (kind) {
      // 上行两音: 发出去了
      case "send":
        tone(c, 660, t, 0.07, 0.09);
        tone(c, 880, t + 0.06, 0.09, 0.09);
        break;
      // 上行三音, 尾音长一点: 完成了(最常听到的一个, 所以最克制)
      case "done":
        tone(c, 523.25, t, 0.09, 0.08);
        tone(c, 659.25, t + 0.09, 0.09, 0.08);
        tone(c, 783.99, t + 0.18, 0.18, 0.08);
        break;
      // 下行两音: 出错了
      case "error":
        tone(c, 440, t, 0.12, 0.10);
        tone(c, 311.13, t + 0.12, 0.20, 0.10);
        break;
      // 单音: 提醒
      case "notify":
        tone(c, 987.77, t, 0.12, 0.07);
        break;
    }
  } catch { /* 见上: 出声失败不影响业务 */ }
}
